// Message type constants shared across contexts (popup, service worker,
// content script, offscreen, app tab). Keeps the string protocol in one place.

export const MSG = {
  // popup/app -> service worker
  START_SYNC: "START_SYNC", // { collection?: string, limit?: number, reclassify?: boolean }
  CANCEL_SYNC: "CANCEL_SYNC",
  GET_STATUS: "GET_STATUS",
  LIST_COLLECTIONS: "LIST_COLLECTIONS",
  RECLASSIFY_ALL: "RECLASSIFY_ALL",
  CLEAR_DATA: "CLEAR_DATA",
  RESET_SYNC: "RESET_SYNC", // clear the resume cursor/complete flag (keeps posts) -> forces a fresh full crawl

  // service worker -> content script (runs on instagram.com)
  FETCH_COLLECTIONS: "FETCH_COLLECTIONS",
  FETCH_SAVED_PAGE: "FETCH_SAVED_PAGE", // { collectionPk?, maxId? }

  // service worker <-> offscreen
  OFFSCREEN_INIT: "OFFSCREEN_INIT", // { model, categories }
  OFFSCREEN_CLASSIFY: "OFFSCREEN_CLASSIFY", // { items:[{id,caption,thumbBlob}], weights, threshold }

  // service worker -> any open UI (broadcast)
  PROGRESS: "PROGRESS", // { phase, done, total, message }
  DONE: "DONE", // { counts }
  ERROR: "ERROR", // { message, where }
};

// Promise wrapper around chrome.runtime.sendMessage.
export function send(message) {
  return chrome.runtime.sendMessage(message);
}

// Broadcast progress to any listening UI; ignore "no receiver" errors.
// Also mirror errors + phase changes into the shared log so we can see them.
// (Static import — dynamic import() is disallowed in service workers.)
import { addLog } from "./log.js";

export function broadcast(message) {
  try {
    if (message && message.type === MSG.ERROR) addLog("error", `${message.where}: ${message.message}`);
    else if (message && message.type === MSG.DONE) addLog("info", `done — ${message.total} post(s)`);
    else if (message && message.type === MSG.PROGRESS && message.message) addLog("info", message.message);
  } catch (_) {}
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {
    /* no receivers */
  }
}
