// Offscreen classifier. Two engines:
//  - "embed" (preferred): hand-wired CLIP — precompute normalized TEXT embeddings
//    for category prototypes (mean-pooled over the descriptive phrases, prompt-
//    ensembled) + tag embeddings ONCE, encode each IMAGE once, blend image+caption
//    by cosine. Fast (~10x) and honors imageWeight/captionWeight.
//  - "pipeline" (fallback): the zero-shot-image-classification pipeline, but fed the
//    real descriptive phrases (not display names). Used if the embed path fails to
//    load or self-test (this CLIP API previously threw "Missing input_ids", so we
//    verify it works before committing to it).
// The active engine is logged so we always know which path ran.

import { MSG, broadcast } from "../lib/messaging.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";
import { addLog } from "../lib/log.js";
import { UNCATEGORIZED, expandPrompts, detectIntentCategories } from "../lib/categories.js";
import { TAG_VOCAB, extractCaptionKeywords } from "../lib/tags.js";
import { getPost, putPost, getThumbnail } from "../lib/db.js";

self.addEventListener("unhandledrejection", (e) => addLog("error", "offscreen: " + ((e.reason && e.reason.message) || e.reason)));
self.addEventListener("error", (e) => addLog("error", "offscreen: " + (e.message || e)));

const TEMP = 100; // CLIP logit_scale ~= exp(log(1/0.07)) ~= 100
const TAG_FLOOR = 0.2; // min cosine for a keyword tag (embed engine)

let T = null;
let engine = null; // "embed" | "pipeline"
let emb = null; // { tokenizer, processor, textModel, visionModel }
let embedModelId = null; // which model the embed engine actually committed to
let pipe = null;
let cache = { key: null }; // prototypes/tag embeddings or pipeline labels, keyed by categories JSON

async function loadTransformers() {
  if (T) return T;
  try {
    T = await import(chrome.runtime.getURL("src/lib/transformers.min.js"));
  } catch (e) {
    throw new Error("transformers.js not vendored. Run `bash extension/setup.sh`. (" + (e.message || e) + ")");
  }
  T.env.allowLocalModels = false;
  T.env.allowRemoteModels = true;
  try {
    T.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("src/wasm/");
    T.env.backends.onnx.wasm.numThreads = 1;
  } catch (_) {}
  return T;
}

// --- math helpers -------------------------------------------------------
function l2(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function softmax(scores) {
  const scaled = scores.map((s) => s * TEMP);
  const m = Math.max(...scaled);
  const ex = scaled.map((s) => Math.exp(s - m));
  const sum = ex.reduce((a, b) => a + b, 0) || 1;
  return ex.map((e) => e / sum);
}
function mergeKeywords(tags, caption, max = 6) {
  const out = [], seen = new Set();
  for (const t of tags) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } if (out.length >= 4) break; }
  for (const w of extractCaptionKeywords(caption, 3)) { if (out.length >= max) break; if (!seen.has(w)) { seen.add(w); out.push(w); } }
  return out.slice(0, max);
}

// Build post.categories from RAW blended cosine — NOT softmax. TEMP=100 makes the
// softmax winner-take-all (sums to 1), so a genuine second class almost never
// clears a probability threshold; the raw cosine keeps runners-up comparable.
// Engine-agnostic: rawScores is parallel to catNames (blended cosine for embed,
// aggregated catScore for pipeline). Caption-driven intent labels (Tutorials,
// Reels) are appended INDEPENDENTLY of scoring — that's what makes a cooking
// tutorial land in both "Food & Cooking" and "Tutorials".
function assembleCategories({ catNames, rawScores, primaryIdx, primaryIsUncat, caption, settings }) {
  const intent = detectIntentCategories(caption, catNames);
  const cap = settings.maxLabels ?? 3;
  if (primaryIsUncat) {
    // an intent match can still rescue an otherwise-Uncategorized post
    return (intent.length ? intent : [UNCATEGORIZED]).slice(0, cap);
  }
  const primary = catNames[primaryIdx];
  const out = [primary];
  if (settings.multiLabel !== false) {
    const top = rawScores[primaryIdx];
    const margin = settings.secondaryMargin ?? 0.9;
    const secondaries = catNames
      .map((c, i) => ({ c, s: rawScores[i] }))
      .filter((x) => x.c !== primary && x.c !== UNCATEGORIZED && x.s >= margin * top)
      .sort((a, b) => b.s - a.s)
      .slice(0, cap - 1)
      .map((x) => x.c);
    out.push(...secondaries);
  }
  for (const c of intent) if (!out.includes(c)) out.push(c);
  return out.slice(0, cap);
}

// --- embed engine -------------------------------------------------------
async function encodeTexts(texts) {
  const inputs = emb.tokenizer(texts, { padding: true, truncation: true });
  const out = await emb.textModel(inputs);
  const tensor = out.text_embeds || out.pooler_output || out;
  const [n, d] = tensor.dims;
  const vecs = [];
  for (let i = 0; i < n; i++) vecs.push(l2(tensor.data.subarray(i * d, (i + 1) * d)));
  return vecs;
}
async function encodeImage(image) {
  const inputs = await emb.processor(image);
  const out = await emb.visionModel(inputs);
  const tensor = out.image_embeds || out.pooler_output || out;
  return l2(tensor.data);
}

// Fallback model tried if the configured one can't be made to encode. The real fix
// is the "merged" strategy below, which works on any model whose merged CLIP graph
// the pipeline can already run — so this is just a second roll of the same dice.
const FALLBACK_MODEL = "Xenova/clip-vit-base-patch16";

// Produce { textModel, visionModel } as async callables compatible with
// encodeTexts/encodeImage (which read out.text_embeds / out.image_embeds). Two modes:
//   "merged" (primary): the standard export (e.g. Xenova/clip-vit-base-patch32) ships
//     ONLY the merged two-tower graph, so a vision-only forward is impossible — encoding
//     an image alone throws "Missing input_ids", AND transformers.js 2.17.2's CLIPModel
//     has no get_*_features. BUT image_embeds depends only on pixel_values and text_embeds
//     only on input_ids, so we run the merged graph feeding a throwaway DUMMY to the other
//     tower and read just the output we want. This is the exact graph the pipeline already
//     runs (so it loads wherever the pipeline does), but we cache the text side and encode
//     each image once — the ~10x win the split path was meant to give, restored.
//   "split": models that genuinely ship separate text_model/vision_model ONNX exports
//     (kept only as a secondary attempt; known to fail on patch16/patch32 in 2.17.2).
async function buildEmbedModels(t, modelId, mode, opts, tokenizer, processor) {
  if (mode === "split") {
    const textModel = await t.CLIPTextModelWithProjection.from_pretrained(modelId, opts);
    const visionModel = await t.CLIPVisionModelWithProjection.from_pretrained(modelId, opts);
    return { textModel, visionModel };
  }
  const model = await t.CLIPModel.from_pretrained(modelId, opts);
  // Dummies just satisfy the merged graph's required inputs; the output we read
  // (image_embeds / text_embeds) does not depend on the dummy tower.
  const dummyImage = new t.RawImage(new Uint8ClampedArray(4 * 4 * 3), 4, 4, 3);
  const { pixel_values: dummyPixels } = await processor(dummyImage);
  const dummyText = tokenizer(["a photo"], { padding: true, truncation: true });
  return {
    textModel: (inputs) => model({ ...inputs, pixel_values: dummyPixels }),
    visionModel: (inputs) => model({ ...inputs, ...dummyText }),
  };
}

async function initEmbed(modelId) {
  const t = await loadTransformers();
  broadcast({ type: MSG.PROGRESS, phase: "model", message: "Loading CLIP model (first run downloads ~90 MB)…" });
  const opts = { quantized: true };
  // Try strategies in order; commit to the first that passes BOTH self-tests. Each is
  // isolated so a throw (e.g. the historic "Missing input_ids") just moves on. "merged"
  // is primary because it runs the same graph the pipeline uses — it works wherever the
  // pipeline does, so the fast path is finally reachable.
  const attempts = [
    { label: `merged:${modelId}`, model: modelId, mode: "merged" },
    { label: `split:${modelId}`, model: modelId, mode: "split" },
    { label: `merged:${FALLBACK_MODEL}`, model: FALLBACK_MODEL, mode: "merged" },
  ];
  const test = new t.RawImage(new Uint8ClampedArray(4 * 4 * 3), 4, 4, 3);
  let lastErr = null;
  for (const a of attempts) {
    try {
      const tokenizer = await t.AutoTokenizer.from_pretrained(a.model);
      const processor = await t.AutoProcessor.from_pretrained(a.model);
      const { textModel, visionModel } = await buildEmbedModels(t, a.model, a.mode, opts, tokenizer, processor);
      emb = { tokenizer, processor, textModel, visionModel };
      embedModelId = a.model;
      // Self-test BOTH paths (vision historically threw). Use TWO texts so a graph that
      // ties text/image batch sizes would fail HERE, not at first real use.
      await encodeImage(test);
      await encodeTexts(["a photo of a cat", "a city skyline at night"]);
      addLog("info", `classifier: embed self-test OK via ${a.label}`);
      return;
    } catch (e) {
      emb = null;
      lastErr = e;
      addLog("info", `classifier: embed attempt ${a.label} failed — ${(e && e.message) || e}`);
    }
  }
  throw lastErr || new Error("no embed strategy passed self-test");
}

async function buildEmbedPrototypes(categories) {
  const key = JSON.stringify(categories);
  if (cache.key === key && cache.protos) return cache;
  const catNames = Object.keys(categories);
  const protos = [];
  for (const name of catNames) {
    const vecs = await encodeTexts(expandPrompts(categories[name]));
    const d = vecs[0].length;
    const avg = new Float32Array(d);
    for (const v of vecs) for (let i = 0; i < d; i++) avg[i] += v[i];
    for (let i = 0; i < d; i++) avg[i] /= vecs.length;
    protos.push(l2(avg));
  }
  const tagEmb = await encodeTexts(TAG_VOCAB.map((t) => "a photo of " + t));
  cache = { key, catNames, protos, tagEmb };
  return cache;
}

async function classifyEmbed(post, caption, blob, settings) {
  const image = await T.RawImage.fromBlob(blob);
  const imgVec = await encodeImage(image);
  let capVec = null;
  if (caption) { const [v] = await encodeTexts([caption.slice(0, 200)]); capVec = v; }

  const { catNames, protos, tagEmb } = await buildEmbedPrototypes(settings.categories);
  const iw = settings.imageWeight ?? 0.45, cw = settings.captionWeight ?? 0.55;
  const scores = protos.map((p) => {
    let s = dot(imgVec, p) * (capVec ? iw : 1);
    if (capVec) s += cw * dot(capVec, p);
    return s;
  });
  const probs = softmax(scores);
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  post.confidence = probs[best];
  post.category = probs[best] >= settings.threshold ? catNames[best] : UNCATEGORIZED;
  post.scores = catNames.map((c, i) => ({ category: c, p: probs[i] })).sort((a, b) => b.p - a.p).slice(0, 3);
  post.categories = assembleCategories({
    catNames, rawScores: scores, primaryIdx: best,
    primaryIsUncat: probs[best] < settings.threshold, caption, settings,
  });
  post.category = post.categories[0];

  const topTags = tagEmb
    .map((te, i) => ({ t: TAG_VOCAB[i], s: dot(imgVec, te) }))
    .filter((x) => x.s >= TAG_FLOOR)
    .sort((a, b) => b.s - a.s).slice(0, 4).map((x) => x.t);
  post.keywords = mergeKeywords(topTags, caption);
}

// --- pipeline engine (fallback) -----------------------------------------
async function initPipeline(modelId) {
  const t = await loadTransformers();
  broadcast({ type: MSG.PROGRESS, phase: "model", message: "Loading CLIP model (pipeline)…" });
  pipe = await t.pipeline("zero-shot-image-classification", modelId, { quantized: true });
}
function buildPipelineLabels(categories) {
  const key = "pipe:" + JSON.stringify(categories);
  if (cache.key === key && cache.labels) return cache;
  const catNames = Object.keys(categories);
  const phraseToCat = {};
  const phrases = [];
  for (const name of catNames) for (const ph of categories[name]) { phrases.push(ph); phraseToCat[ph] = name; }
  cache = { key, catNames, phrases, phraseToCat, labels: [...phrases, ...TAG_VOCAB] };
  return cache;
}
async function classifyPipeline(post, caption, blob, settings) {
  const image = await T.RawImage.fromBlob(blob);
  const { catNames, phrases, phraseToCat, labels } = buildPipelineLabels(settings.categories);
  const out = await pipe(image, labels, { hypothesis_template: "a photo of {}" });
  const score = {};
  for (const o of out) score[o.label] = o.score;
  // aggregate phrase scores back to their category (max)
  const catScore = {};
  for (const ph of phrases) { const c = phraseToCat[ph]; catScore[c] = Math.max(catScore[c] || 0, score[ph] || 0); }
  const sum = catNames.reduce((a, c) => a + (catScore[c] || 0), 0) || 1;
  let best = catNames[0], bestS = -1;
  for (const c of catNames) { const p = (catScore[c] || 0) / sum; if (p > bestS) { bestS = p; best = c; } }
  post.confidence = bestS;
  post.category = bestS >= settings.threshold ? best : UNCATEGORIZED;
  post.scores = catNames.map((c) => ({ category: c, p: (catScore[c] || 0) / sum })).sort((a, b) => b.p - a.p).slice(0, 3);
  post.categories = assembleCategories({
    catNames, rawScores: catNames.map((c) => catScore[c] || 0), primaryIdx: catNames.indexOf(best),
    primaryIsUncat: bestS < settings.threshold, caption, settings,
  });
  post.category = post.categories[0];
  // tags: renormalize across tags + floor
  const tagSum = TAG_VOCAB.reduce((a, t) => a + (score[t] || 0), 0) || 1;
  const topTags = TAG_VOCAB.map((t) => ({ t, s: (score[t] || 0) / tagSum }))
    .sort((a, b) => b.s - a.s).slice(0, 4).filter((x) => x.s >= 1.5 / TAG_VOCAB.length).map((x) => x.t);
  post.keywords = mergeKeywords(topTags, caption);
}

// --- driver -------------------------------------------------------------
async function ensureEngine(modelId) {
  if (engine) return;
  try {
    await initEmbed(modelId);
    engine = "embed";
    addLog("info", `classifier: embedding path (fast, caption-blend, phrases) — model ${embedModelId}`);
  } catch (e) {
    addLog("error", "embedding path unavailable, using pipeline: " + ((e && e.message) || e));
    await initPipeline(modelId);
    engine = "pipeline";
    addLog("info", "classifier: pipeline path (image-only, phrases)");
  }
}

async function classifyIds(ids, settingsIn) {
  const settings = { ...DEFAULT_SETTINGS, ...(settingsIn || {}) };
  await ensureEngine(settings.model);

  let done = 0, errorCount = 0, firstErrorMsg = null;
  for (const id of ids) {
    try {
      const post = await getPost(id);
      if (!post || post.manualOverride) { done++; continue; }
      const caption = (post.caption || "").trim();
      const blob = await getThumbnail(id);

      if (!blob) {
        if (post.thumbnailUrl) { post.status = "needs_thumb"; }
        else {
          const intent = detectIntentCategories(caption, Object.keys(settings.categories));
          post.categories = intent.length ? intent : [UNCATEGORIZED];
          post.category = post.categories[0];
          post.confidence = 0; post.keywords = mergeKeywords([], caption); post.status = "done";
        }
        await putPost(post);
        done++;
        continue;
      }

      if (engine === "embed") await classifyEmbed(post, caption, blob, settings);
      else await classifyPipeline(post, caption, blob, settings);
      post.status = "done";
      post.error = null;
      await putPost(post);
    } catch (e) {
      errorCount++;
      if (!firstErrorMsg) firstErrorMsg = String((e && e.message) || e);
      const post = await getPost(id);
      if (post) { post.status = "error"; post.error = String(e.message || e); await putPost(post); }
    }
    done++;
    if (done % 3 === 0 || done === ids.length) {
      broadcast({ type: MSG.PROGRESS, phase: "classify", done, total: ids.length, message: `Classified ${done}/${ids.length}` });
    }
  }
  if (errorCount) broadcast({ type: MSG.ERROR, where: "classify", message: `${errorCount} of ${ids.length} failed (${firstErrorMsg})` });
}

// Serialize classify requests — never run two inferences on the shared model.
let inFlight = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== MSG.OFFSCREEN_CLASSIFY) return;
  inFlight = inFlight.then(() => classifyIds(msg.ids || [], msg.settings)).catch((e) => {
    broadcast({ type: MSG.ERROR, where: "classify", message: String((e && e.message) || e) });
  });
  inFlight.then(() => sendResponse({ ok: true }));
  return true;
});
