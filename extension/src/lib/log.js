// Tiny shared logger. Uses its own IndexedDB so it works in EVERY context
// (service worker, offscreen doc, gallery) — offscreen can't use chrome.storage.
// Keeps the last ~1000 entries; the gallery shows + copies them. (Big enough that
// a full crawl's per-page fetch logs survive a following classify pass — see the
// `noLog` hint on high-frequency progress in messaging.js/classifier.js.)

const DB = "igss-logs";
const STORE = "logs";
const MAX = 1000;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function nowStr() {
  try { return new Date().toISOString().slice(11, 23); } catch (_) { return ""; }
}

export async function addLog(level, msg) {
  try {
    const db = await open();
    await new Promise((res) => {
      const tx = db.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      s.add({ t: nowStr(), level: String(level), msg: String(msg) });
      // Trim oldest beyond MAX.
      s.count().onsuccess = (e) => {
        let over = e.target.result - MAX;
        if (over > 0) {
          s.openCursor().onsuccess = (ev) => {
            const cur = ev.target.result;
            if (cur && over-- > 0) { cur.delete(); cur.continue(); }
          };
        }
      };
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    db.close();
  } catch (_) {}
}

export async function getLogs() {
  try {
    const db = await open();
    const out = await new Promise((res) => {
      const s = db.transaction(STORE, "readonly").objectStore(STORE);
      s.getAll().onsuccess = (e) => res(e.target.result || []);
    });
    db.close();
    return out;
  } catch (_) { return []; }
}

export async function clearLogs() {
  try {
    const db = await open();
    await new Promise((res) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    db.close();
  } catch (_) {}
}
