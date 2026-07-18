// Offscreen classifier. Uses transformers.js's official zero-shot-image-
// classification pipeline (which builds the model inputs correctly) instead of
// hand-wiring CLIP. Scores each thumbnail against the category names + a tag
// vocabulary in one pass, then stores category + keywords in IndexedDB.

import { MSG, broadcast } from "../lib/messaging.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";
import { addLog } from "../lib/log.js";
import { UNCATEGORIZED } from "../lib/categories.js";
import { TAG_VOCAB, extractCaptionKeywords } from "../lib/tags.js";
import { getPost, putPost, getThumbnail } from "../lib/db.js";

self.addEventListener("unhandledrejection", (e) => addLog("error", "offscreen: " + ((e.reason && e.reason.message) || e.reason)));
self.addEventListener("error", (e) => addLog("error", "offscreen: " + (e.message || e)));

let T = null; // transformers.js module
let pipe = null; // zero-shot-image-classification pipeline

async function loadTransformers() {
  if (T) return T;
  try {
    T = await import(chrome.runtime.getURL("src/lib/transformers.min.js"));
  } catch (e) {
    throw new Error(
      "transformers.js is not vendored. Run `bash extension/setup.sh` once. (" + (e.message || e) + ")"
    );
  }
  T.env.allowLocalModels = false;
  T.env.allowRemoteModels = true; // weights fetched once from HF, then cached
  try {
    T.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("src/wasm/");
    T.env.backends.onnx.wasm.numThreads = 1;
  } catch (_) {}
  return T;
}

async function ensurePipe(modelId) {
  if (pipe) return;
  const t = await loadTransformers();
  broadcast({ type: MSG.PROGRESS, phase: "model", message: "Loading CLIP model (first run downloads ~90 MB)…" });
  pipe = await t.pipeline("zero-shot-image-classification", modelId, { quantized: true });
}

function mergeKeywords(tags, caption, max = 6) {
  const out = [];
  const seen = new Set();
  for (const t of tags) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } if (out.length >= 4) break; }
  for (const w of extractCaptionKeywords(caption, 3)) { if (out.length >= max) break; if (!seen.has(w)) { seen.add(w); out.push(w); } }
  return out.slice(0, max);
}

async function classifyIds(ids, settingsIn) {
  // Settings come from the service worker (offscreen can't read chrome.storage).
  const settings = { ...DEFAULT_SETTINGS, ...(settingsIn || {}) };
  await ensurePipe(settings.model);

  const catNames = Object.keys(settings.categories);
  const labels = [...catNames, ...TAG_VOCAB];
  const catSet = new Set(catNames);

  let done = 0;
  let firstErrorShown = false;
  for (const id of ids) {
    try {
      const post = await getPost(id);
      if (!post || post.manualOverride) { done++; continue; }
      const caption = (post.caption || "").trim();
      const blob = await getThumbnail(id);

      if (!blob) {
        post.category = UNCATEGORIZED;
        post.confidence = 0;
        post.keywords = mergeKeywords([], caption);
        post.status = "done";
        await putPost(post);
        done++;
        continue;
      }

      const image = await T.RawImage.fromBlob(blob);
      const out = await pipe(image, labels, { hypothesis_template: "a photo of {}" });
      const score = {};
      for (const o of out) score[o.label] = o.score;

      // Scores are softmaxed over ALL labels (categories + tags), so each is
      // tiny. Renormalize across just the categories to get a real category
      // distribution before thresholding — otherwise everything looks < 0.15.
      const catSum = catNames.reduce((a, c) => a + (score[c] || 0), 0) || 1;
      const catNorm = {};
      for (const c of catNames) catNorm[c] = (score[c] || 0) / catSum;

      let best = catNames[0], bestS = -1;
      for (const c of catNames) { if (catNorm[c] > bestS) { bestS = catNorm[c]; best = c; } }
      post.confidence = bestS;
      post.category = bestS >= settings.threshold ? best : UNCATEGORIZED;
      post.scores = catNames.map((c) => ({ category: c, p: catNorm[c] })).sort((a, b) => b.p - a.p).slice(0, 3);

      // keywords: top tags (from the same pass) + caption words
      const topTags = TAG_VOCAB.map((t) => ({ t, s: score[t] || 0 })).sort((a, b) => b.s - a.s).slice(0, 4).map((x) => x.t);
      post.keywords = mergeKeywords(topTags, caption);
      post.status = "done";
      await putPost(post);
    } catch (e) {
      if (!firstErrorShown) {
        firstErrorShown = true;
        broadcast({ type: MSG.ERROR, where: "classify", message: String((e && e.message) || e) });
      }
      const post = await getPost(id);
      if (post) { post.status = "done"; post.category = UNCATEGORIZED; post.error = String(e.message || e); await putPost(post); }
    }
    done++;
    if (done % 3 === 0 || done === ids.length) {
      broadcast({ type: MSG.PROGRESS, phase: "classify", done, total: ids.length, message: `Classified ${done}/${ids.length}` });
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== MSG.OFFSCREEN_CLASSIFY) return;
  classifyIds(msg.ids || [], msg.settings)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => {
      broadcast({ type: MSG.ERROR, where: "classify", message: String((e && e.message) || e) });
      sendResponse({ ok: false, error: String(e.message || e) });
    });
  return true;
});
