// Service worker: orchestrates a sync. It cannot run the ML model (no WASM in a
// SW), so it drives the content script (fetching from instagram.com) and the
// offscreen document (CLIP classification), and does the thumbnail downscaling
// itself (OffscreenCanvas IS available in a service worker).

import { MSG, broadcast } from "../lib/messaging.js";
import { getSettings } from "../lib/settings.js";
import { addLog } from "../lib/log.js";
import { normalizePage, normalizeCollections } from "../lib/ig-normalize.js";

self.addEventListener("unhandledrejection", (e) => addLog("error", "sw: " + ((e.reason && e.reason.message) || e.reason)));
self.addEventListener("error", (e) => addLog("error", "sw: " + (e.message || e)));
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

// Buffer of captures relayed from the page interceptor.
let capture = { template: null, pages: [] };
function resetCapture() {
  capture = { template: null, pages: [] };
}

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
let offscreenReady = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  // Single-flight: two callers must not both createDocument (the 2nd throws
  // "Only a single offscreen document may be created").
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({
        url: "src/offscreen/offscreen.html",
        reasons: ["WORKERS"],
        justification: "Run the local CLIP model (WASM) to classify saved posts.",
      })
      .catch((e) => {
        if (!/single offscreen document/i.test(String(e && e.message))) {
          offscreenReady = null;
          throw e;
        }
      });
  }
  await offscreenReady;
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

// Recover posts whose thumbnail download failed on a prior run (status
// "needs_thumb"): re-download, and on success flip them to "pending" so they
// get classified. Bounded so a permanently-dead URL eventually gives up.
async function recoverThumbnails() {
  const need = await getPostsByStatus("needs_thumb");
  for (const p of need) {
    if (cancelRequested) break;
    p.thumbTries = (p.thumbTries || 0) + 1;
    if (p.thumbnailUrl && p.thumbTries <= 3) {
      try {
        await putThumbnail(p.id, await fetchThumbnailBlob(p.thumbnailUrl));
        p.status = "pending";
      } catch (_) {}
    } else if (p.thumbTries > 3) {
      p.status = "done";
      p.category = "Uncategorized";
    }
    await putPost(p);
  }
}

let classifying = false;
async function classifyPending() {
  if (classifying) return; // never run two classify passes on the shared model
  classifying = true;
  try {
    await recoverThumbnails();
    const pending = await getPostsByStatus("pending");
    if (!pending.length) return;
    await ensureOffscreen();
    const ids = pending.map((p) => p.id);
    // Pass settings in — the offscreen doc can't read chrome.storage itself.
    const settings = await getSettings();
    await sendToOffscreen({ type: MSG.OFFSCREEN_CLASSIFY, ids, settings });
  } finally {
    classifying = false;
  }
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

// Find the Instagram Saved-page tab. We search ALL tabs (not just the active
// one) so Sync works from the gallery tab too — when you click Sync in the
// gallery, the gallery is the active tab, not Instagram.
async function getActiveSavedTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  const saved = tabs.filter((t) => /\/saved\//.test(t.url || ""));
  if (saved.length) {
    return (saved.find((t) => t.active) || saved[0]).id;
  }
  if (tabs.length) {
    throw new Error(
      "An Instagram tab is open but not on your Saved page. Go to Profile → " +
        "Saved → a collection (URL contains /saved/), then click Sync."
    );
  }
  throw new Error("Open instagram.com, go to your Saved page, then click Sync.");
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

// Make sure the interceptor (MAIN) + relay (ISOLATED) are present even if the
// tab predates the extension load (content_scripts wouldn't have run).
async function injectInterceptor(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["src/content/interceptor.js"] });
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", files: ["src/content/relay.js"] });
  } catch (_) {}
}

// Nudge the page to make Instagram fire its own saved-feed request.
async function nudgeScroll(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: () => window.scrollTo(0, document.body.scrollHeight),
    });
  } catch (_) {}
}

async function waitFor(pred, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(200);
  }
  return pred();
}

// Replay the captured request with a new pagination cursor, in the page (so
// cookies + tokens apply). Returns parsed JSON or {__error}.
async function replayInPage(tabId, template, cursor) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    args: [template, cursor],
    func: async (tpl, cur) => {
      try {
        let { method = "GET", url, headers = {}, body } = tpl;
        method = method.toUpperCase();
        // Drop headers the browser must set itself.
        const clean = {};
        for (const k in headers) {
          if (!/^(cookie|host|content-length|user-agent|referer|origin|accept-encoding)$/i.test(k)) clean[k] = headers[k];
        }
        if (method === "GET") {
          const u = new URL(url);
          u.searchParams.set("max_id", cur);
          url = u.toString();
        } else if (body) {
          try {
            const params = new URLSearchParams(body);
            if (params.has("variables")) {
              const v = JSON.parse(params.get("variables"));
              ["after", "max_id", "end_cursor", "cursor"].forEach((k) => { if (k in v) v[k] = cur; });
              if (!("after" in v) && !("max_id" in v)) v.after = cur;
              params.set("variables", JSON.stringify(v));
              body = params.toString();
            } else if (/max_id=/.test(body)) {
              body = body.replace(/(max_id=)[^&]*/, "$1" + encodeURIComponent(cur));
            }
          } catch (_) {
            try { const j = JSON.parse(body); if (j.variables) { j.variables.after = cur; body = JSON.stringify(j); } } catch (_) {}
          }
        }
        const r = await fetch(url, { method, headers: clean, body: method === "GET" ? undefined : body, credentials: "include" });
        if (!r.ok) return { __error: "HTTP " + r.status };
        return await r.json();
      } catch (e) { return { __error: String((e && e.message) || e) }; }
    },
  });
  return (res && res.result) || { __error: "no result" };
}

async function runSync({ limit } = {}) {
  if (syncing) return;
  syncing = true;
  cancelRequested = false;
  resetCapture();
  try {
    const tabId = await getActiveSavedTab();
    await injectInterceptor(tabId);
    broadcast({ type: MSG.PROGRESS, phase: "fetch", done: 0, total: null, message: "Reading your saved posts…" });

    const seen = new Set();
    let stored = 0;

    // Store a batch of normalized items (dedupe + incremental). Returns #new.
    async function processItems(items) {
      let n = 0;
      for (const it of items) {
        if (cancelRequested || (limit && stored >= limit)) break;
        if (!it || !it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        // Skip only when we already have BOTH the record and its thumbnail — a
        // prior thumbnail failure must remain re-fetchable, not permanently skipped.
        if ((await getPost(it.id)) && (await getThumbnail(it.id))) continue;
        if (it.thumbnailUrl) {
          try {
            await putThumbnail(it.id, await fetchThumbnailBlob(it.thumbnailUrl));
          } catch (_) {
            it.status = "needs_thumb"; // retryable, not a permanent Uncategorized
          }
        }
        await putPost(it);
        stored++; n++;
      }
      broadcast({ type: MSG.PROGRESS, phase: "fetch", done: seen.size, total: null, message: `Found ${seen.size} saved post(s)…` });
      return n;
    }

    let lastCursor = null, anyData = false;
    async function drainCaptured() {
      let newTotal = 0;
      while (capture.pages.length) {
        const page = normalizePage(capture.pages.shift());
        if (page.items.length) anyData = true;
        newTotal += await processItems(page.items);
        if (page.nextMaxId) lastCursor = page.nextMaxId;
      }
      return newTotal;
    }

    // 1) Trigger Instagram's own request, then read what the interceptor caught.
    await nudgeScroll(tabId);
    await waitFor(() => capture.template || capture.pages.length, 9000);
    let hadNew = (await drainCaptured()) > 0;
    addLog("info", `fetch: captured template=${!!capture.template}, cursor=${lastCursor ? "yes" : "no"}, firstBatch=${stored}`);

    // 2) Primary: replay the captured request with cursors (no scrolling).
    if (capture.template && lastCursor) {
      addLog("info", "fetch: using API replay (no scroll)");
      let cursor = lastCursor, pages = 0, stale = 0;
      while (cursor && pages < MAX_PAGES && !cancelRequested && !(limit && stored >= limit)) {
        const raw = await replayInPage(tabId, capture.template, cursor);
        if (!raw || raw.__error) { addLog("error", `replay page ${pages + 1} failed: ${raw && raw.__error}`); break; }
        const page = normalizePage(raw);
        const n = await processItems(page.items);
        await drainCaptured();
        pages++;
        addLog("info", `replay page ${pages}: +${n} new, total ${stored}, cursor=${page.nextMaxId ? "yes" : "no"}`);
        if (n === 0) { if (++stale >= 2) break; } else stale = 0; // early-exit: nothing new
        if (!page.moreAvailable && !page.nextMaxId) break;
        cursor = page.nextMaxId || lastCursor;
        await sleep(500);
      }
      addLog("info", `fetch: replay finished (${pages} pages, ${stored} stored)`);
    } else {
      // 3) Fallbacks: robust scroll (harvesting intercepted responses), then DOM scrape.
      addLog("info", "fetch: NO replay (no captured request) — falling back to scrolling");
      await scrollInterceptFallback(tabId, processItems, drainCaptured);
    }

    broadcast({ type: MSG.PROGRESS, phase: "classify", done: 0, total: seen.size, message: "Classifying…" });
    await classifyPending();
    broadcast({ type: MSG.DONE, total: await countPosts() });
  } catch (e) {
    broadcast({ type: MSG.ERROR, where: "sync", message: String(e.message || e) });
  } finally {
    syncing = false;
  }
}

// Fallback: scroll robustly; the interceptor harvests the JSON responses IG
// makes. If nothing is ever intercepted, fall back to DOM scraping the grid.
async function scrollInterceptFallback(tabId, processItems, drainCaptured) {
  let stable = 0, sawData = false;
  for (let round = 0; round < 3000 && !cancelRequested; round++) {
    await nudgeScroll(tabId);
    await sleep(900);
    const n = await drainCaptured();
    if (n > 0) { sawData = true; stable = 0; } else if (++stable >= 4) break;
  }
  if (sawData) return;
  // Nothing intercepted at all → DOM scrape the rendered grid.
  let stable2 = 0, prev = -1;
  for (let round = 0; round < 3000 && !cancelRequested; round++) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: scrapeChunk, args: [4, 800] });
    const raw = (res && res.result) || [];
    const items = raw.map((r) => ({
      id: r.code, code: r.code, caption: r.caption || "",
      thumbnailUrl: r.thumbnailUrl || null, permalink: `https://www.instagram.com/p/${r.code}/`,
      takenAt: null, status: "pending", category: null, confidence: 0, manualOverride: false,
    }));
    await processItems(items);
    if (raw.length === prev) { if (++stable2 >= 3) break; } else stable2 = 0;
    prev = raw.length;
  }
}

// --- message router -----------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // Captures relayed from the page interceptor (no response needed).
  if (msg.type === "IG_CAPTURE") {
    if (msg.kind === "page" && msg.json) {
      if (msg.template && !capture.template) {
        capture.template = msg.template;
        const u = String(msg.template.url || "").split("?")[0];
        addLog("info", `intercepted ${msg.template.method || "?"} …${u.slice(-52)}`);
      }
      capture.pages.push(msg.json);
    }
    return; // fire-and-forget
  }

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
        try {
          if (syncing || classifying) {
            sendResponse({ ok: false, error: "Busy — a sync/classify is already running." });
            return;
          }
          // Re-queue done + previously-errored posts (skip manual overrides).
          for (const status of ["done", "error"]) {
            for (const p of await getPostsByStatus(status)) {
              if (p.manualOverride) continue;
              p.status = "pending";
              await putPost(p);
            }
          }
          await classifyPending();
          sendResponse({ ok: true });
        } catch (e) {
          broadcast({ type: MSG.ERROR, where: "reclassify", message: String(e.message || e) });
          sendResponse({ ok: false, error: String(e.message || e) });
        }
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
