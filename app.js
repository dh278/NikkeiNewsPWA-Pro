/**
 * app.js (Ver.5)
 *
 * 処理の流れ:
 *   1. PdfProcessor.renderAllPages()  … PDFの全ページを画像化するだけ
 *   2. GeminiExtract.extractAll()     … 画像から記事認識+300字要約+
 *                                        過去の関連動向+企業名を一括生成
 *   3. 各記事に、元になったページの画像(dataUrl)をそのまま持たせておく
 *      → 「元のPDFページを見る」はこの画像を表示するだけで済む
 *         (クリック時に再レンダリングする必要がない)
 */

const STORAGE_KEY_GEMINI = "nikkei-radar-gemini-key";

let state = {
  articles: [],
  selectedId: null,
  searchQuery: "",
  favOnly: false,
};

// ---------- 起動時チェック ----------

window.addEventListener("load", () => {
  if (typeof pdfjsLib === "undefined") {
    document.getElementById("lib-error").classList.remove("hidden");
  } else {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
});

// ---------- Gemini APIキー ----------

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
  status.textContent = "保存しました。";
  status.className = "status ok";
});

// ---------- PDF取込 → Gemini抽出(一括) ----------

const inputPdf = document.getElementById("input-pdf");
const progressWrap = document.getElementById("ocr-progress");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");

inputPdf.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const apiKey = getGeminiKey();
  if (!apiKey) {
    alert("設定画面でGoogle Gemini APIキーを登録してください。");
    inputPdf.value = "";
    return;
  }

  progressWrap.classList.remove("hidden");
  progressFill.style.width = "0%";
  progressLabel.textContent = "PDFをページ画像に変換中...";

  try {
    const pdfId = `pdf-${Date.now()}`;

    // 1. 全ページを画像化(テキスト抽出やOCRは行わない)
    const { images, totalPages } = await PdfProcessor.renderAllPages(
      file,
      (cur, total) => {
        const pct = Math.round((cur / total) * 50); // 全体の前半50%をレンダリングに割り当て
        progressFill.style.width = pct + "%";
        progressLabel.textContent = `ページ画像に変換中... (${cur}/${total}ページ)`;
      }
    );

    // 2. Geminiに画像を渡して、記事の認識+300字要約+過去の関連動向を一括生成
    const rawArticles = await GeminiExtract.extractAll(images, apiKey, (curBatch, totalBatches) => {
      const pct = 50 + Math.round((curBatch / totalBatches) * 50); // 後半50%をGemini処理に割り当て
      progressFill.style.width = pct + "%";
      progressLabel.textContent = `Geminiで記事を解析中... (${curBatch}/${totalBatches}バッチ)`;
    });

    // 3. 各記事に、元ページの画像をそのまま持たせる(「元のPDFページを見る」用)
    const imageByPage = {};
    for (const img of images) imageByPage[img.pageNum] = img.dataUrl;

    const analyzed = rawArticles.map((a) => ({
      id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      favorite: false,
      createdAt: new Date().toISOString(),
      pdfId,
      pageNumber: a.page,
      headline: a.headline || "(見出し不明)",
      isRawArticle: !!a.isRaw,
      summary: a.summary || "",
      history: a.history || "",
      companies: Array.isArray(a.companies) ? a.companies : [],
      pageImageDataUrl: imageByPage[a.page] || null,
    }));

    await NikkeiDB.bulkAdd(analyzed);
    state.articles = [...analyzed, ...state.articles];
    render();

    progressLabel.textContent = `完了: ${analyzed.length}件の記事を抽出しました(全${totalPages}ページ)`;
  } catch (err) {
    console.error(err);
    progressLabel.textContent = "エラー: " + err.message;
  } finally {
    inputPdf.value = "";
    setTimeout(() => progressWrap.classList.add("hidden"), 5000);
  }
});

// ---------- 検索 ----------

document.getElementById("input-search").addEventListener("input", (e) => {
  state.searchQuery = e.target.value.trim().toLowerCase();
  renderList();
});
document.getElementById("filter-fav-only").addEventListener("change", (e) => {
  state.favOnly = e.target.checked;
  renderList();
});

// ---------- 集計・フィルタ ----------

function getFilteredArticles() {
  return state.articles.filter(a => {
    if (state.favOnly && !a.favorite) return false;
    if (!state.searchQuery) return true;
    const haystack = [a.headline, a.summary, a.history, ...(a.companies || [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(state.searchQuery);
  });
}

function topN(counterMap, n = 5) {
  return [...counterMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function renderDashboard() {
  document.getElementById("stat-count").textContent = state.articles.length;
  document.getElementById("stat-fav").textContent = state.articles.filter(a => a.favorite).length;

  const companyCounts = new Map();
  for (const a of state.articles) {
    for (const c of a.companies || []) companyCounts.set(c, (companyCounts.get(c) || 0) + 1);
  }
  renderBreakdownList("breakdown-companies", topN(companyCounts), (name, count) => `${name}(${count}件)`);
}

function renderBreakdownList(elId, entries, formatter) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = "";
  if (entries.length === 0) {
    el.innerHTML = `<li class="empty">データなし</li>`;
    return;
  }
  for (const [name, count] of entries) {
    const li = document.createElement("li");
    li.textContent = formatter(name, count);
    el.appendChild(li);
  }
}

// ---------- 記事一覧(営業カード) ----------

function renderList() {
  const listEl = document.getElementById("article-list");
  const filtered = getFilteredArticles();

  if (filtered.length === 0) {
    listEl.innerHTML = `<li class="empty">記事はまだありません</li>`;
    return;
  }

  listEl.innerHTML = "";
  for (const a of filtered) {
    const li = document.createElement("li");
    li.className = "sales-card" + (a.id === state.selectedId ? " active" : "");
    li.addEventListener("click", () => selectArticle(a.id));

    const isSelected = a.id === state.selectedId;
    const badges = (a.companies || []).map(c => `<span class="badge badge-company">${escapeHtml(c)}</span>`).join("");

    // AI要約(300字)をプレビュー表示。タップで元のPDFページを直接開く。
    let previewHtml = "";
    if (!isSelected) {
      if (a.isRawArticle) {
        previewHtml = `<p class="card-preview raw-note js-open-pdf" data-id="${a.id}">${escapeHtml((a.summary || "").slice(0, 120))}…(人事・データ表/タップで元PDF)</p>`;
      } else if (a.summary) {
        previewHtml = `<p class="card-preview gemini-summary js-open-pdf" data-id="${a.id}" title="タップで元のPDFページを表示">${escapeHtml(a.summary)}</p>`;
      }
    }

    const historyHtml =
      !a.isRawArticle && a.history
        ? `<div class="detail-section history"><strong>過去の関連動向</strong><div class="body-text">${escapeHtml(a.history)}</div></div>`
        : "";

    const expandedHtml = isSelected
      ? `
        <div class="card-expanded">
          <div class="detail-section">
            <strong>${a.isRawArticle ? "内容(そのまま書き起こし)" : `AI要約(${(a.summary || "").length}字)`}</strong>
            <div class="body-text">${escapeHtml(a.summary || "")}</div>
          </div>
          ${historyHtml}
          <div class="detail-section">
            <strong>企業:</strong> ${(a.companies || []).join("、") || "なし"}
          </div>
          <div class="detail-section">
            ${a.pageImageDataUrl
              ? `<img class="pdf-page-image" src="${a.pageImageDataUrl}" alt="元PDF p.${a.pageNumber}">`
              : `<p class="empty">元PDFページの画像がありません</p>`}
          </div>
        </div>
      `
      : "";

    li.innerHTML = `
      <div class="card-top">
        <span class="card-title">${escapeHtml(a.headline)}</span>
        <span class="fav-star ${a.favorite ? "active" : ""}" data-id="${a.id}">${a.favorite ? "★" : "☆"}</span>
      </div>
      ${a.isRawArticle ? `<span class="badge badge-deal">人事/データ</span>` : ""}
      ${previewHtml}
      <div class="card-badges">${badges}</div>
      <div class="card-meta">p.${a.pageNumber} ・ タップで${isSelected ? "折りたたむ" : "全文表示"}</div>
      ${expandedHtml}
    `;

    li.querySelector(".fav-star").addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleFavorite(a.id);
    });

    // AI要約プレビューをタップ → カードを開きつつ、元のPDFページ画像を表示する
    const summaryLink = li.querySelector(".js-open-pdf");
    if (summaryLink) {
      summaryLink.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.selectedId = a.id;
        render();
      });
    }

    listEl.appendChild(li);
  }
}

function renderDetail() {
  const detailEl = document.getElementById("article-detail");
  const a = state.articles.find(x => x.id === state.selectedId);
  if (!a) {
    detailEl.innerHTML = `<p class="empty">記事を選択してください</p>`;
    return;
  }

  const historyHtml =
    !a.isRawArticle && a.history
      ? `<div class="detail-section history"><strong>過去の関連動向</strong><div class="body-text">${escapeHtml(a.history)}</div></div>`
      : "";

  detailEl.innerHTML = `
    <h3>${escapeHtml(a.headline)}</h3>
    <div class="detail-meta">
      p.${a.pageNumber} ・ 取込日時: ${new Date(a.createdAt).toLocaleString("ja-JP")}
    </div>
    <div class="detail-section">
      <strong>${a.isRawArticle ? "内容(そのまま書き起こし)" : `AI要約(${(a.summary || "").length}字)`}</strong>
      <div class="body-text">${escapeHtml(a.summary || "")}</div>
    </div>
    ${historyHtml}
    <div class="detail-section">
      <strong>企業:</strong> ${(a.companies || []).join("、") || "なし"}
    </div>
    ${a.pageImageDataUrl ? `<img class="pdf-page-image" src="${a.pageImageDataUrl}" alt="元PDF p.${a.pageNumber}">` : ""}
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
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
  renderDetail();
}

// ---------- 初期化 ----------

(async () => {
  state.articles = await NikkeiDB.getAll();
  state.articles.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  render();
})();
