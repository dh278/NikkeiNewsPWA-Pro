/**
 * app.js (Ver.5)
 * PDFページ画像をGeminiに渡して記事一覧(見出し+要約+登場企業)を取得し、
 * IndexedDBに保存・一覧表示するだけのシンプルな構成。
 */

const STORAGE_KEY_GEMINI = "nikkei-radar-gemini-key";

let state = {
  articles: [],
  selectedId: null,
  searchQuery: "",
  favOnly: false,
  openPdfViewId: null,
  pdfLoadingIds: new Set()
};

// レンダリング済みPDFページ画像のキャッシュ(articleId → [{pageNum, dataUrl}])。セッション内のみ。
const pdfImageCache = {};

// ---------- 起動時チェック ----------

window.addEventListener("load", () => {
  if (typeof pdfjsLib === "undefined") {
    document.getElementById("lib-error").classList.remove("hidden");
  }
});

// ---------- APIキー ----------

function getGeminiKey() {
  return localStorage.getItem(STORAGE_KEY_GEMINI) || "";
}
function setGeminiKey(key) {
  localStorage.setItem(STORAGE_KEY_GEMINI, key);
}

const panelSettings = document.getElementById("panel-settings");
document.getElementById("btn-settings").addEventListener("click", () => {
  document.getElementById("input-gemini-key").value = getGeminiKey();
  panelSettings.classList.remove("hidden");
});
document.getElementById("btn-close-settings").addEventListener("click", () => {
  panelSettings.classList.add("hidden");
});
document.getElementById("btn-save-key").addEventListener("click", () => {
  const key = document.getElementById("input-gemini-key").value.trim();
  setGeminiKey(key);
  const status = document.getElementById("key-status");
  status.textContent = key ? "保存しました。" : "未設定として保存しました。";
  status.className = "status " + (key ? "ok" : "error");
});

document.getElementById("btn-clear-all").addEventListener("click", async () => {
  if (!confirm("保存済みの記事とPDFを全て削除します。よろしいですか?")) return;
  await NikkeiDB.clearAll();
  state.articles = [];
  state.selectedId = null;
  state.openPdfViewId = null;
  render();
  alert("削除しました。");
});

// ---------- PDF取込 ----------

const inputPdf = document.getElementById("input-pdf");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");

inputPdf.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const apiKey = getGeminiKey();
  if (!apiKey) {
    alert("先に「設定」からGemini APIキーを入力・保存してください。");
    inputPdf.value = "";
    return;
  }

  progressWrap.classList.remove("hidden");
  progressFill.style.width = "0%";
  progressLabel.textContent = "PDFを画像に変換中...";

  try {
    const { images, totalPages } = await PdfProcessor.renderAllPages(file, (cur, total) => {
      const pct = Math.round((cur / total) * 50); // 前半50%を画像化に割り当て
      progressFill.style.width = pct + "%";
      progressLabel.textContent = `PDF画像化中... (${cur}/${total}ページ)`;
    });

    const extracted = await GeminiExtract.extractAll(images, apiKey, (curBatch, totalBatches) => {
      const pct = 50 + Math.round((curBatch / totalBatches) * 50);
      progressFill.style.width = pct + "%";
      progressLabel.textContent = `Geminiで要約中... (${curBatch}/${totalBatches}バッチ)`;
    });

    const pdfId = `pdf-${Date.now()}`;
    await NikkeiDB.savePdf(pdfId, file);

    const now = new Date().toISOString();
    const analyzed = extracted
      .filter(a => a && a.headline)
      .map(a => ({
        id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        pdfId,
        pageNum: Number(a.page) || null,
        headline: String(a.headline).slice(0, 120),
        summary: String(a.summary || "").slice(0, 400),
        companies: Array.isArray(a.companies) ? a.companies.filter(Boolean) : [],
        favorite: false,
        createdAt: now
      }));

    await NikkeiDB.bulkAdd(analyzed);
    state.articles = [...analyzed, ...state.articles];
    render();

    progressLabel.textContent = `完了: ${analyzed.length}件の記事を抽出しました(全${totalPages}ページ)。`;
  } catch (err) {
    console.error(err);
    progressLabel.textContent = "エラー: " + err.message;
  } finally {
    inputPdf.value = "";
    setTimeout(() => progressWrap.classList.add("hidden"), 5000);
  }
});

// ---------- 検索・お気に入り ----------

document.getElementById("input-search").addEventListener("input", (e) => {
  state.searchQuery = e.target.value.trim().toLowerCase();
  renderList();
});
document.getElementById("filter-fav-only").addEventListener("change", (e) => {
  state.favOnly = e.target.checked;
  renderList();
});

function getFilteredArticles() {
  return state.articles.filter(a => {
    if (state.favOnly && !a.favorite) return false;
    if (!state.searchQuery) return true;
    const haystack = [a.headline, a.summary, ...(a.companies || [])].join(" ").toLowerCase();
    return haystack.includes(state.searchQuery);
  });
}

// ---------- 元のPDFページを見る ----------

async function handleShowPdfPage(article) {
  const id = article.id;

  if (state.openPdfViewId === id) {
    state.openPdfViewId = null;
    render();
    return;
  }
  state.openPdfViewId = id;

  if (pdfImageCache[id]) {
    render();
    return;
  }
  if (!article.pdfId || !article.pageNum) {
    alert("このPDFの保存データが見つかりませんでした(古い取込データの可能性があります)。");
    state.openPdfViewId = null;
    return;
  }

  state.pdfLoadingIds.add(id);
  render();

  try {
    const blob = await NikkeiDB.getPdf(article.pdfId);
    if (!blob) throw new Error("保存されたPDFが見つかりません。再取込みが必要です。");

    const arrayBuffer = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    // 記事がページの区切りをまたいで後半が切れることがあるため、次のページも一緒に表示する
    const startPage = Math.min(Math.max(1, article.pageNum), pdf.numPages);
    const pageNums = [startPage];
    if (startPage + 1 <= pdf.numPages) pageNums.push(startPage + 1);

    const images = [];
    for (const pageNum of pageNums) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push({ pageNum, dataUrl: canvas.toDataURL("image/png") });
      canvas.width = 0;
      canvas.height = 0;
    }
    pdfImageCache[id] = images;
  } catch (err) {
    console.error(err);
    pdfImageCache[id] = null;
    alert("PDFページの表示に失敗しました: " + err.message);
  } finally {
    state.pdfLoadingIds.delete(id);
    render();
  }
}

// ---------- 描画 ----------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function renderDashboard() {
  document.getElementById("stat-count").textContent = state.articles.length;
  document.getElementById("stat-fav").textContent = state.articles.filter(a => a.favorite).length;
}

function renderList() {
  const listEl = document.getElementById("article-list");
  const filtered = getFilteredArticles();

  if (filtered.length === 0) {
    listEl.innerHTML = `<li class="empty">記事はまだありません</li>`;
    return;
  }

  listEl.innerHTML = "";
  for (const a of filtered) {
    const isSelected = a.id === state.selectedId;
    const li = document.createElement("li");
    li.className = "sales-card" + (isSelected ? " active" : "");
    li.addEventListener("click", () => selectArticle(a.id));

    const badges = (a.companies || [])
      .map(c => `<span class="badge badge-company">${escapeHtml(c)}</span>`)
      .join("");

    const isPdfViewOpen = state.openPdfViewId === a.id;
    const isPdfLoading = state.pdfLoadingIds.has(a.id);
    let pdfViewHtml = "";
    if (isPdfViewOpen) {
      if (isPdfLoading) {
        pdfViewHtml = `<p class="ai-loading">PDFページを読み込み中...</p>`;
      } else if (pdfImageCache[a.id] && pdfImageCache[a.id].length) {
        pdfViewHtml = pdfImageCache[a.id]
          .map(img => `<img class="pdf-page-image" src="${img.dataUrl}" alt="元PDF p.${img.pageNum}">`)
          .join("");
      }
    }

    const expandedHtml = isSelected
      ? `
        <div class="card-expanded">
          <div class="detail-section">
            <button class="btn-show-pdf btn-secondary" data-id="${a.id}">
              ${isPdfViewOpen ? "元のPDFを閉じる" : `元のPDFページを見る (p.${a.pageNum || "?"})`}
            </button>
            ${pdfViewHtml}
          </div>
        </div>
      `
      : "";

    li.innerHTML = `
      <div class="card-top">
        <span class="card-title">${escapeHtml(a.headline)}</span>
        <span class="fav-star ${a.favorite ? "active" : ""}" data-id="${a.id}">${a.favorite ? "★" : "☆"}</span>
      </div>
      <div class="card-summary">${escapeHtml(a.summary)}</div>
      <div class="card-badges">${badges}</div>
      <div class="card-meta">p.${a.pageNum || "?"} ・ タップで${isSelected ? "閉じる" : "元PDFを見る"}</div>
      ${expandedHtml}
    `;

    li.querySelector(".fav-star").addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleFavorite(a.id);
    });
    const pdfBtn = li.querySelector(".btn-show-pdf");
    if (pdfBtn) {
      pdfBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handleShowPdfPage(a);
      });
    }

    listEl.appendChild(li);
  }
}

function selectArticle(id) {
  state.selectedId = state.selectedId === id ? null : id;
  render();
}

async function toggleFavorite(id) {
  const a = state.articles.find(x => x.id === id);
  if (!a) return;
  a.favorite = !a.favorite;
  await NikkeiDB.put(a);
  render();
}

function render() {
  renderDashboard();
  renderList();
}

// ---------- 初期化 ----------

(async () => {
  state.articles = await NikkeiDB.getAll();
  state.articles.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  render();
})();
