// Offscreen classifier: loads a local CLIP model (transformers.js) and scores
// each saved post by blending its thumbnail image with its caption. Reads
// posts + thumbnail blobs + settings from storage itself, writes the category
// back to IndexedDB, and broadcasts PROGRESS as it goes.

import { MSG, broadcast } from "../lib/messaging.js";
import { getSettings } from "../lib/settings.js";
import { expandPrompts, UNCATEGORIZED } from "../lib/categories.js";
import { getPost, putPost, getThumbnail } from "../lib/db.js";

let T = null; // transformers.js module
let model = null;
let processor = null;
let tokenizer = null;
let labelCache = { key: null, names: [], vectors: [] };

async function loadTransformers() {
  if (T) return T;
  try {
    T = await import(chrome.runtime.getURL("src/lib/transformers.min.js"));
  } catch (e) {
    throw new Error(
      "transformers.js is not vendored. Run `bash extension/setup.sh` once to " +
        "download the model runtime. (" + (e.message || e) + ")"
    );
  }
  T.env.allowLocalModels = false;
  T.env.allowRemoteModels = true; // model weights (data, not code) fetched once, then cached
  try {
    T.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("src/wasm/");
    T.env.backends.onnx.wasm.numThreads = 1; // SharedArrayBuffer often unavailable here
  } catch (_) {}
  return T;
}

async function ensureModel(modelId) {
  if (model) return;
  const t = await loadTransformers();
  broadcast({ type: MSG.PROGRESS, phase: "model", message: "Loading CLIP model (first run downloads ~90 MB)…" });
  model = await t.CLIPModel.from_pretrained(modelId, { quantized: true });
  processor = await t.AutoProcessor.from_pretrained(modelId);
  tokenizer = await t.AutoTokenizer.from_pretrained(modelId);
}

function l2normalize(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function softmax(scores, temp = 100) {
  const scaled = scores.map((s) => s * temp);
  const m = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - m));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

// Encode a batch of strings -> array of normalized Float32Array embeddings.
async function encodeTexts(texts) {
  const inputs = tokenizer(texts, { padding: true, truncation: true });
  const out = await model.get_text_features(inputs);
  const tensor = out.text_embeds || out; // tolerate either shape
  const data = tensor.data;
  const [n, d] = tensor.dims;
  const vecs = [];
  for (let i = 0; i < n; i++) {
    vecs.push(l2normalize(data.subarray(i * d, (i + 1) * d)));
  }
  return vecs;
}

async function encodeImage(blob) {
  const image = await T.RawImage.fromBlob(blob);
  const inputs = await processor(image);
  const out = await model.get_image_features(inputs);
  const tensor = out.image_embeds || out;
  return l2normalize(tensor.data);
}

// Build one averaged, normalized embedding per category (cached).
async function ensureLabelEmbeddings(categories) {
  const key = JSON.stringify(categories);
  if (labelCache.key === key) return labelCache;
  const names = Object.keys(categories);
  const vectors = [];
  for (const name of names) {
    const prompts = expandPrompts(categories[name]);
    const embs = await encodeTexts(prompts);
    // average then normalize
    const d = embs[0].length;
    const avg = new Float32Array(d);
    for (const e of embs) for (let i = 0; i < d; i++) avg[i] += e[i];
    for (let i = 0; i < d; i++) avg[i] /= embs.length;
    vectors.push(l2normalize(avg));
  }
  labelCache = { key, names, vectors };
  return labelCache;
}

function blend(imgVec, capVec, imageWeight, captionWeight) {
  if (!capVec) return imgVec;
  const d = imgVec.length;
  const out = new Float32Array(d);
  for (let i = 0; i < d; i++) out[i] = imageWeight * imgVec[i] + captionWeight * capVec[i];
  return l2normalize(out);
}

async function classifyIds(ids) {
  const settings = await getSettings();
  await ensureModel(settings.model);
  const labels = await ensureLabelEmbeddings(settings.categories);

  let done = 0;
  for (const id of ids) {
    try {
      const post = await getPost(id);
      if (!post || post.manualOverride) {
        done++;
        continue;
      }
      const blob = await getThumbnail(id);

      let imgVec = null;
      if (blob) imgVec = await encodeImage(blob);

      let capVec = null;
      const caption = (post.caption || "").trim();
      if (caption) {
        const [v] = await encodeTexts([caption.slice(0, 300)]);
        capVec = v;
      }

      let scores;
      if (imgVec && capVec) {
        const q = blend(imgVec, capVec, settings.imageWeight, settings.captionWeight);
        scores = labels.vectors.map((lv) => dot(q, lv));
      } else if (imgVec) {
        scores = labels.vectors.map((lv) => dot(imgVec, lv));
      } else if (capVec) {
        scores = labels.vectors.map((lv) => dot(capVec, lv));
      } else {
        // nothing to go on
        post.status = "done";
        post.category = UNCATEGORIZED;
        post.confidence = 0;
        await putPost(post);
        done++;
        continue;
      }

      const probs = softmax(scores);
      let bestIdx = 0;
      for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bestIdx]) bestIdx = i;

      post.confidence = probs[bestIdx];
      post.category = probs[bestIdx] >= settings.threshold ? labels.names[bestIdx] : UNCATEGORIZED;
      post.scores = labels.names.map((n, i) => ({ category: n, p: probs[i] }))
        .sort((a, b) => b.p - a.p)
        .slice(0, 3);
      post.status = "done";
      await putPost(post);
    } catch (e) {
      const post = await getPost(id);
      if (post) {
        post.status = "done";
        post.category = UNCATEGORIZED;
        post.error = String(e.message || e);
        await putPost(post);
      }
    }
    done++;
    if (done % 3 === 0 || done === ids.length) {
      broadcast({ type: MSG.PROGRESS, phase: "classify", done, total: ids.length, message: `Classified ${done}/${ids.length}` });
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== MSG.OFFSCREEN_CLASSIFY) return;
  classifyIds(msg.ids || [])
    .then(() => sendResponse({ ok: true }))
    .catch((e) => {
      broadcast({ type: MSG.ERROR, where: "classify", message: String(e.message || e) });
      sendResponse({ ok: false, error: String(e.message || e) });
    });
  return true;
});
