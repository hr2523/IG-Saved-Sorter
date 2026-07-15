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
export function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {
    /* no receivers */
  }
}
