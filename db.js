/**
 * db.js
 * IndexedDBによる記事の永続化。iPhone/GitHub Pages(静的サイト)で
 * 無料かつ大量件数(数万件想定)を扱うために localStorage ではなくこちらを採用。
 *
 * 記事本文(articles)とページ画像(pages)は別ストアに分離している。
 * 同じページを複数の記事が参照することがあるため、画像はページ単位で
 * 1回だけ保存し、記事側はページ番号だけを持つ(重複保存を避けるため)。
 */

const NikkeiDB = (() => {
  const DB_NAME = "nikkei-radar-db";
  const DB_VERSION = 3;
  const STORE = "articles";
  const PAGES_STORE = "pages"; // key: `${newspaperDate}_${pageNum}`

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
        if (db.objectStoreNames.contains("pdfs")) {
          db.deleteObjectStore("pdfs"); // Ver.5では未使用(画像はpagesストアへ移行)
        }
        if (!db.objectStoreNames.contains(PAGES_STORE)) {
          const pages = db.createObjectStore(PAGES_STORE, { keyPath: "key" });
          pages.createIndex("newspaperDate", "newspaperDate", { unique: false });
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
      const tx = db.transaction([STORE, PAGES_STORE], "readwrite");
      tx.objectStore(STORE).clear();
      tx.objectStore(PAGES_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ---------- ページ画像(重複排除・日付ひもづけ) ----------

  function pageKey(newspaperDate, pageNum) {
    return `${newspaperDate}_${pageNum}`;
  }

  async function putPages(newspaperDate, pages) {
    // pages: [{ pageNum, dataUrl }]
    if (!pages.length) return;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PAGES_STORE, "readwrite");
      const store = tx.objectStore(PAGES_STORE);
      for (const p of pages) {
        store.put({
          key: pageKey(newspaperDate, p.pageNum),
          newspaperDate,
          pageNum: p.pageNum,
          dataUrl: p.dataUrl,
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function getPage(newspaperDate, pageNum) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PAGES_STORE, "readonly");
      const req = tx.objectStore(PAGES_STORE).get(pageKey(newspaperDate, pageNum));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 90日より古いページ画像を削除する(記事のテキストデータ自体は消さない)
  async function purgeOldPages(retentionDays = 90) {
    const db = await open();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(PAGES_STORE, "readwrite");
      const store = tx.objectStore(PAGES_STORE);
      const index = store.index("newspaperDate");
      const range = IDBKeyRange.upperBound(cutoffStr, true); // cutoffStrより前(未満)
      const req = index.openCursor(range);
      let deleted = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  return { bulkAdd, put, getAll, clear, putPages, getPage, purgeOldPages };
})();
