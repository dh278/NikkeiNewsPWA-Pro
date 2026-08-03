/**
 * db.js
 * IndexedDBによる記事の永続化。iPhone/GitHub Pages(静的サイト)で
 * 無料かつ大量件数(数万件想定)を扱うために localStorage ではなくこちらを採用。
 */

const NikkeiDB = (() => {
  const DB_NAME = "nikkei-radar-v5-db";
  const DB_VERSION = 2;
  const STORE = "articles";
  const PDF_STORE = "pdfs";

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("favorite", "favorite", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(PDF_STORE)) {
          db.createObjectStore(PDF_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function bulkAdd(articles) {
    if (!articles.length) return;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const a of articles) store.put(a);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function put(article) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(article);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function getAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function clear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, PDF_STORE], "readwrite");
      tx.objectStore(STORE).clear();
      tx.objectStore(PDF_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ---------- PDF本体の保存(元ページへのジャンプ機能用) ----------

  async function savePdf(id, blob) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PDF_STORE, "readwrite");
      tx.objectStore(PDF_STORE).put({ id, blob });
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function getPdf(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PDF_STORE, "readonly");
      const req = tx.objectStore(PDF_STORE).get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  return { bulkAdd, put, getAll, clear, clearAll, savePdf, getPdf };
})();
