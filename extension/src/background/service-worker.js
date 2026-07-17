// Service worker: orchestrates a sync. It cannot run the ML model (no WASM in a
// SW), so it drives the content script (fetching from instagram.com) and the
// offscreen document (CLIP classification), and does the thumbnail downscaling
// itself (OffscreenCanvas IS available in a service worker).

import { MSG, broadcast } from "../lib/messaging.js";
import { getSettings } from "../lib/settings.js";
import { normalizePage, normalizeCollections } from "../lib/ig-normalize.js";
import {
  putPost,
  getPost,
  putThumbnail,
  getPostsByStatus,
  clearAll,
  countPosts,
} from "../lib/db.js";

const IG_APP_ID = "936619743392459";
const API = "https://www.instagram.com/api/v1";

let syncing = false;
let cancelRequested = false;

const MAX_PAGES = 5000; // very generous safety backstop (~100k+ posts)
const PAGE_DELAY_MS = 900; // polite throttle between pages

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- instagram tab ------------------------------------------------------
async function getInstagramTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  if (tabs.length) {
    // Prefer a fully-loaded tab.
    const ready = tabs.find((t) => t.status === "complete") || tabs[0];
    return ready.id;
  }
  const tab = await chrome.tabs.create({ url: "https://www.instagram.com/", active: false });
  await waitForTabComplete(tab.id);
  return tab.id;
}

async function waitForTabComplete(tabId, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return;
    } catch (_) {}
    await sleep(500);
  }
}

// Run a GET fetch INSIDE the instagram.com page (so cookies + origin are the
// page's), and return the parsed JSON. No content-script messaging — this is
// injected on demand and returns its result directly, so there's no "receiving
// end" to miss.
async function inPageFetch(tabId, url) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url, IG_APP_ID],
    func: async (u, appId) => {
      function cookie(name) {
        const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
        return m ? decodeURIComponent(m[1]) : "";
      }
      const r = await fetch(u, {
        method: "GET",
        credentials: "include",
        headers: {
          "x-ig-app-id": appId,
          "x-requested-with": "XMLHttpRequest",
          "x-csrftoken": cookie("csrftoken"),
        },
      });
      if (!r.ok) return { __error: `HTTP ${r.status} ${r.statusText}` };
      try {
        return { __json: await r.json() };
      } catch (e) {
        return { __error: "non-JSON response (endpoint likely changed)" };
      }
    },
  });
  const out = res && res.result;
  if (!out) throw new Error("no response from page (is an instagram.com tab open and logged in?)");
  if (out.__error) throw new Error(out.__error + " — the saved-posts endpoint may have changed.");
  return out.__json;
}

const qp = (maxId) => (maxId ? `?max_id=${encodeURIComponent(maxId)}` : "");

// Candidate endpoint builders (Instagram's private web API path has changed over
// time and differs by account). We try each until one doesn't 404, then cache
// the winner for the rest of the run.
function savedAllCandidates(maxId) {
  return [
    `${API}/feed/saved/posts/${qp(maxId)}`,
    `${API}/feed/saved/${qp(maxId)}`,
    `${API}/feed/collection/ALL_MEDIA_AUTO_COLLECTION/posts/${qp(maxId)}`,
    `${API}/feed/collection/ALL_MEDIA_AUTO_COLLECTION/${qp(maxId)}`,
  ];
}
function collectionCandidates(pk, maxId) {
  return [
    `${API}/feed/collection/${encodeURIComponent(pk)}/posts/${qp(maxId)}`,
    `${API}/feed/collection/${encodeURIComponent(pk)}/${qp(maxId)}`,
  ];
}
function endpointCollectionsList() {
  return `${API}/collections/list/?collection_types=` + encodeURIComponent('["ALL_MEDIA_AUTO_COLLECTION","MEDIA"]');
}

let cachedSavedTemplate = null; // remembers the working URL builder across pages

async function fetchCollections(tabId) {
  return normalizeCollections(await inPageFetch(tabId, endpointCollectionsList()));
}

async function fetchSavedPage(tabId, collectionPk, maxId) {
  const isCollection = collectionPk && !String(collectionPk).toUpperCase().includes("ALL_MEDIA");
  // If we already found a working endpoint this run, reuse it.
  if (cachedSavedTemplate) {
    return normalizePage(await inPageFetch(tabId, cachedSavedTemplate(maxId)));
  }
  const candidates = isCollection
    ? collectionCandidates(collectionPk, maxId)
    : savedAllCandidates(maxId);
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    try {
      const json = await inPageFetch(tabId, candidates[i]);
      // Remember which template worked (rebuild with the same index).
      cachedSavedTemplate = (m) =>
        (isCollection ? collectionCandidates(collectionPk, m) : savedAllCandidates(m))[i];
      return normalizePage(json);
    } catch (e) {
      lastErr = e;
      if (/HTTP 404/.test(String(e.message))) continue; // try next variant
      throw e; // 403/other -> real problem, surface it
    }
  }
  throw new Error(
    "All known saved-posts endpoints returned 404. Instagram changed the API — " +
      "please capture the real request (DevTools → Network → Copy as cURL). Last: " +
      String(lastErr && lastErr.message)
  );
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

// Send a message to the offscreen document, retrying until its listener is
// registered (createDocument resolves before the module script finishes
// loading, so an immediate send can miss the receiver -> "Receiving end does
// not exist"). This is what makes classification reliably run.
async function sendToOffscreen(message, tries = 30) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      lastErr = e;
      await sleep(400);
    }
  }
  throw new Error(
    "Classifier never became ready: " + String((lastErr && lastErr.message) || lastErr) +
      ". Did you run `bash extension/setup.sh`?"
  );
}

async function classifyPending() {
  const pending = await getPostsByStatus("pending");
  if (!pending.length) return;
  await ensureOffscreen();
  const ids = pending.map((p) => p.id);
  // Offscreen reads posts+thumbnails+settings from storage itself and writes
  // results back to IndexedDB, broadcasting PROGRESS as it goes.
  await sendToOffscreen({ type: MSG.OFFSCREEN_CLASSIFY, ids });
}

// --- sync ---------------------------------------------------------------
async function resolveCollectionPk(tabId, collectionName) {
  if (!collectionName || /^all( posts| saved)?$/i.test(collectionName.trim())) {
    return null; // All Posts
  }
  const cols = await fetchCollections(tabId);
  const wanted = collectionName.trim().toLowerCase();
  const match = cols.find((c) => (c.name || "").trim().toLowerCase() === wanted);
  if (!match) {
    const names = cols.map((c) => c.name).filter(Boolean).join(", ");
    throw new Error(`Collection "${collectionName}" not found. Available: ${names}`);
  }
  return match.pk;
}

// The active tab must be showing a Saved page (…/saved/…). We read posts from
// the rendered grid rather than Instagram's private API (which 404s on GraphQL-
// only accounts). Returns the tab id.
async function getActiveSavedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";
  if (!/^https:\/\/www\.instagram\.com\//.test(url)) {
    throw new Error("Open instagram.com in the active tab, go to your Saved page, then Sync.");
  }
  if (!/\/saved\//.test(url)) {
    throw new Error(
      "Open your Saved page first: Profile → Saved → the collection you want " +
        "(URL should contain /saved/). Then click Sync."
    );
  }
  return tab.id;
}

// Injected into the page: scroll a few times and return EVERY saved post seen so
// far (accumulated on window across chunks, since the grid virtualizes and drops
// off-screen nodes).
function scrapeChunk(scrollsPerChunk, delayMs) {
  return new Promise(async (resolve) => {
    window.__igssSaved = window.__igssSaved || {};
    const store = window.__igssSaved;
    function collect() {
      const anchors = document.querySelectorAll(
        'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]'
      );
      for (const a of anchors) {
        const m = (a.getAttribute("href") || "").match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
        if (!m) continue;
        const code = m[2];
        if (store[code]) continue;
        const img = a.querySelector("img");
        store[code] = {
          code,
          thumbnailUrl: img ? img.src : null,
          caption: img ? img.alt || "" : "",
        };
      }
    }
    collect();
    for (let i = 0; i < scrollsPerChunk; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, delayMs));
      collect();
    }
    resolve(Object.values(store));
  });
}

async function runSync({ limit } = {}) {
  if (syncing) return;
  syncing = true;
  cancelRequested = false;
  try {
    const tabId = await getActiveSavedTab();
    broadcast({ type: MSG.PROGRESS, phase: "fetch", done: 0, total: null, message: "Reading your Saved page… (it will auto-scroll)" });

    const processed = new Set();
    let stored = 0;
    let stable = 0;
    let prevSeen = -1;

    for (let round = 0; round < 4000 && !cancelRequested; round++) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: scrapeChunk,
        args: [4, 800],
      });
      const items = (res && res.result) || [];

      for (const raw of items) {
        if (cancelRequested) break;
        if (limit && stored >= limit) break;
        if (processed.has(raw.code)) continue;
        processed.add(raw.code);

        const post = {
          id: raw.code,
          code: raw.code,
          caption: raw.caption || "",
          thumbnailUrl: raw.thumbnailUrl || null,
          permalink: `https://www.instagram.com/p/${raw.code}/`,
          takenAt: null,
          status: "pending",
          category: null,
          confidence: 0,
          manualOverride: false,
        };

        const existing = await getPost(post.id);
        if (existing) continue; // incremental: keep prior classification
        if (post.thumbnailUrl) {
          try {
            const blob = await fetchThumbnailBlob(post.thumbnailUrl);
            await putThumbnail(post.id, blob);
          } catch (_) {}
        }
        await putPost(post);
        stored++;
      }

      broadcast({ type: MSG.PROGRESS, phase: "fetch", done: processed.size, total: null, message: `Found ${processed.size} post(s)…` });

      if (limit && stored >= limit) break;
      // Stop when scrolling stops revealing anything new.
      if (items.length === prevSeen) {
        if (++stable >= 3) break;
      } else {
        stable = 0;
      }
      prevSeen = items.length;
    }

    broadcast({ type: MSG.PROGRESS, phase: "classify", done: 0, total: processed.size, message: "Classifying…" });
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
      // This build reads whatever Saved page you're viewing, so there's no
      // API collection list. Guide the user to navigate instead.
      sendResponse({
        ok: false,
        error:
          "This version sorts whatever Saved page you're on. On Instagram open " +
          "Profile → Saved → the collection (or All posts), then click Sync.",
      });
      return true;

    case MSG.CLEAR_DATA:
      clearAll().then(() => sendResponse({ ok: true }));
      return true;
  }
});
