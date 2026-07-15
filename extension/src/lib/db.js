// Minimal IndexedDB wrapper: two stores.
//   posts:      one record per saved post (metadata + classification result)
//   thumbnails: {id, blob} — the downscaled cover image, so the gallery never
//               depends on Instagram CDN URLs (they are signed and expire).

const DB_NAME = "igss";
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("posts")) {
        const s = db.createObjectStore("posts", { keyPath: "id" });
        s.createIndex("status", "status", { unique: false });
        s.createIndex("category", "category", { unique: false });
      }
      if (!db.objectStoreNames.contains("thumbnails")) {
        db.createObjectStore("thumbnails", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putPost(post) {
  const db = await open();
  try {
    await reqToPromise(tx(db, "posts", "readwrite").put(post));
  } finally {
    db.close();
  }
}

export async function putPosts(posts) {
  const db = await open();
  try {
    const store = tx(db, "posts", "readwrite");
    await Promise.all(posts.map((p) => reqToPromise(store.put(p))));
  } finally {
    db.close();
  }
}

export async function getPost(id) {
  const db = await open();
  try {
    return await reqToPromise(tx(db, "posts", "readonly").get(id));
  } finally {
    db.close();
  }
}

export async function getAllPosts() {
  const db = await open();
  try {
    return await reqToPromise(tx(db, "posts", "readonly").getAll());
  } finally {
    db.close();
  }
}

export async function getPostsByStatus(status) {
  const db = await open();
  try {
    const idx = tx(db, "posts", "readonly").index("status");
    return await reqToPromise(idx.getAll(status));
  } finally {
    db.close();
  }
}

export async function putThumbnail(id, blob) {
  const db = await open();
  try {
    await reqToPromise(tx(db, "thumbnails", "readwrite").put({ id, blob }));
  } finally {
    db.close();
  }
}

export async function getThumbnail(id) {
  const db = await open();
  try {
    const rec = await reqToPromise(tx(db, "thumbnails", "readonly").get(id));
    return rec ? rec.blob : null;
  } finally {
    db.close();
  }
}

export async function clearAll() {
  const db = await open();
  try {
    await reqToPromise(tx(db, "posts", "readwrite").clear());
    await reqToPromise(tx(db, "thumbnails", "readwrite").clear());
  } finally {
    db.close();
  }
}

export async function countPosts() {
  const db = await open();
  try {
    return await reqToPromise(tx(db, "posts", "readonly").count());
  } finally {
    db.close();
  }
}
