// Service worker: orchestrates a sync. It cannot run the ML model (no WASM in a
// SW), so it drives the content script (fetching from instagram.com) and the
// offscreen document (CLIP classification), and does the thumbnail downscaling
// itself (OffscreenCanvas IS available in a service worker).

import { MSG, broadcast } from "../lib/messaging.js";
import { getSettings } from "../lib/settings.js";
import {
  putPost,
  putThumbnail,
  getPostsByStatus,
  clearAll,
  countPosts,
} from "../lib/db.js";

let syncing = false;
let cancelRequested = false;

const MAX_PAGES = 200; // hard safety cap
const PAGE_DELAY_MS = 1000; // polite throttle between pages

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- instagram tab + content script -------------------------------------
async function getInstagramTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  let tabId;
  if (tabs.length) {
    tabId = tabs[0].id;
  } else {
    // Open one in the background.
    const tab = await chrome.tabs.create({
      url: "https://www.instagram.com/",
      active: false,
    });
    tabId = tab.id;
    await sleep(1500); // let it start loading before we inject
  }
  // Inject the fetch script on demand — the tab may predate the extension load,
  // in which case the manifest content script was never injected.
  await ensureContentScript(tabId);
  await waitForContentScript(tabId);
  return tabId;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/ig-fetch.js"],
    });
  } catch (_) {
    /* page may still be loading or not injectable; PING loop will catch it */
  }
}

async function waitForContentScript(tabId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PING" });
      return;
    } catch (_) {
      await sleep(500);
    }
  }
}

async function askContentScript(tabId, message) {
  const res = await chrome.tabs.sendMessage(tabId, message);
  if (!res || !res.ok) {
    throw new Error((res && res.error) || "content script call failed");
  }
  return res.data;
}

// --- thumbnails ---------------------------------------------------------
async function fetchThumbnailBlob(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`thumb ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const max = 256;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

// --- offscreen document -------------------------------------------------
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "src/offscreen/offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run the local CLIP model (WASM) to classify saved posts.",
  });
}

async function classifyPending() {
  const pending = await getPostsByStatus("pending");
  if (!pending.length) return;
  await ensureOffscreen();
  const ids = pending.map((p) => p.id);
  // Offscreen reads posts+thumbnails+settings from storage itself and writes
  // results back to IndexedDB, broadcasting PROGRESS as it goes.
  await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_CLASSIFY, ids });
}

// --- sync ---------------------------------------------------------------
async function resolveCollectionPk(tabId, collectionName) {
  if (!collectionName || /^all( posts| saved)?$/i.test(collectionName.trim())) {
    return null; // All Posts
  }
  const cols = await askContentScript(tabId, { type: "FETCH_COLLECTIONS" });
  const wanted = collectionName.trim().toLowerCase();
  const match = cols.find((c) => (c.name || "").trim().toLowerCase() === wanted);
  if (!match) {
    const names = cols.map((c) => c.name).filter(Boolean).join(", ");
    throw new Error(`Collection "${collectionName}" not found. Available: ${names}`);
  }
  return match.pk;
}

async function runSync({ collection, limit } = {}) {
  if (syncing) return;
  syncing = true;
  cancelRequested = false;
  try {
    const tabId = await getInstagramTab();
    const collectionPk = await resolveCollectionPk(tabId, collection);

    let maxId = null;
    let fetched = 0;
    let pages = 0;
    broadcast({ type: MSG.PROGRESS, phase: "fetch", done: 0, total: null, message: "Fetching saved posts…" });

    do {
      if (cancelRequested) break;
      const page = await askContentScript(tabId, {
        type: "FETCH_SAVED_PAGE",
        collectionPk,
        maxId,
      });

      for (const item of page.items) {
        if (cancelRequested) break;
        if (limit && fetched >= limit) break;
        // Download + downscale the thumbnail; store as a blob (URLs expire).
        if (item.thumbnailUrl) {
          try {
            const blob = await fetchThumbnailBlob(item.thumbnailUrl);
            await putThumbnail(item.id, blob);
          } catch (_) {
            /* keep the post even if the thumbnail failed */
          }
        }
        await putPost(item);
        fetched++;
      }

      broadcast({
        type: MSG.PROGRESS,
        phase: "fetch",
        done: fetched,
        total: null,
        message: `Fetched ${fetched} post(s)…`,
      });

      maxId = page.nextMaxId;
      pages++;
      if (limit && fetched >= limit) break;
      if (page.moreAvailable && maxId) await sleep(PAGE_DELAY_MS);
    } while (maxId && pages < MAX_PAGES && !cancelRequested);

    // Classify everything still pending.
    broadcast({ type: MSG.PROGRESS, phase: "classify", done: 0, total: fetched, message: "Classifying…" });
    await classifyPending();

    const total = await countPosts();
    broadcast({ type: MSG.DONE, total });
  } catch (e) {
    broadcast({ type: MSG.ERROR, where: "sync", message: String(e.message || e) });
  } finally {
    syncing = false;
  }
}

// --- message router -----------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case MSG.START_SYNC:
      runSync(msg);
      sendResponse({ ok: true });
      return true;

    case MSG.CANCEL_SYNC:
      cancelRequested = true;
      sendResponse({ ok: true });
      return true;

    case MSG.GET_STATUS:
      countPosts().then((total) =>
        sendResponse({ ok: true, syncing, total })
      );
      return true;

    case MSG.RECLASSIFY_ALL:
      (async () => {
        const all = await getPostsByStatus("done");
        for (const p of all) {
          if (p.manualOverride) continue;
          p.status = "pending";
          await putPost(p);
        }
        await classifyPending();
        sendResponse({ ok: true });
      })();
      return true;

    case MSG.LIST_COLLECTIONS:
      (async () => {
        try {
          const tabId = await getInstagramTab();
          const cols = await askContentScript(tabId, { type: "FETCH_COLLECTIONS" });
          sendResponse({ ok: true, collections: cols });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;

    case MSG.CLEAR_DATA:
      clearAll().then(() => sendResponse({ ok: true }));
      return true;
  }
});
