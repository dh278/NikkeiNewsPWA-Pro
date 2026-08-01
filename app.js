/**
 * app.js (Ver.4)
 */

const STORAGE_KEY_API = "nikkei-radar-google-vision-key";

let state = {
  articles: [],
  selectedId: null,
  searchQuery: "",
  favOnly: false,
  openPdfViewId: null,
  pdfLoadingIds: new Set()
};

// レンダリング済みPDFページ画像のキャッシュ(articleId → dataURL)。
// 永続化はせず、このセッション内だけの一時キャッシュ。
const pdfImageCache = {};

// ---------- 起動時チェック ----------

window.addEventListener("load", () => {
  if (typeof pdfjsLib === "undefined") {
    document.getElementById("lib-error").classList.remove("hidden");
  } else {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
});

// ---------- APIキー ----------

function getApiKey() {
  return localStorage.getItem(STORAGE_KEY_API) || "";
}
function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY_API, key);
}

const panelSettings = document.getElementById("panel-settings");
document.getElementById("btn-settings").addEventListener("click", () => {
  document.getElementById("input-api-key").value = getApiKey();
  panelSettings.classList.remove("hidden");
});
document.getElementById("btn-close-settings").addEventListener("click", () => {
  panelSettings.classList.add("hidden");
});
document.getElementById("btn-save-key").addEventListener("click", () => {
  const key = document.getElementById("input-api-key").value.trim();
  setApiKey(key);
  const status = document.getElementById("key-status");
  status.textContent = "保存しました。";
  status.className = "status ok";
});

// ---------- PDF取込 ----------

const inputPdf = document.getElementById("input-pdf");
const progressWrap = document.getElementById("ocr-progress");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");

inputPdf.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const apiKey = getApiKey();

  progressWrap.classList.remove("hidden");
  progressFill.style.width = "0%";
  progressLabel.textContent = "PDFを読み込み中...";

  try {
    await Extractor.loadData("");

    const pdfId = `pdf-${Date.now()}`;

    const { rawArticles, totalPages, ocrPageCount, textPageCount } = await PdfProcessor.processPdf(
      file,
      apiKey,
      (cur, total, label) => {
        const pct = Math.round((cur / total) * 100);
        progressFill.style.width = pct + "%";
        progressLabel.textContent = `${label}... (${cur}/${total}ページ)`;
      }
    );

    // 「元のPDFを見る」機能のため、取り込んだPDF自体も保存しておく
    await NikkeiDB.savePdf(pdfId, file);

    const analyzed = rawArticles.map(a =>
      Extractor.analyze({
        ...a,
        id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        favorite: false,
        createdAt: new Date().toISOString(),
        pdfId
      })
    );

    await NikkeiDB.bulkAdd(analyzed);
    state.articles = [...analyzed, ...state.articles];
    render();

    progressLabel.textContent =
      `完了: ${analyzed.length}件抽出(テキスト抽出 ${textPageCount}p / OCR ${ocrPageCount}p / 全${totalPages}p)`;
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
    const haystack = [
      a.headline, a.body,
      ...(a.companies || []), ...(a.regions || []), ...(a.dealTypes || [])
    ].join(" ").toLowerCase();
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
  const regionCounts = new Map();
  const investmentList = [];

  for (const a of state.articles) {
    for (const c of a.companies || []) companyCounts.set(c, (companyCounts.get(c) || 0) + 1);
    for (const r of a.regions || []) regionCounts.set(r, (regionCounts.get(r) || 0) + 1);
    for (const inv of a.investments || []) {
      investmentList.push({ headline: a.headline, id: a.id, ...inv });
    }
  }

  renderBreakdownList("breakdown-companies", topN(companyCounts), (name, count) => `${name}(${count}件)`);
  renderBreakdownList("breakdown-regions", topN(regionCounts), (name, count) => `${name}(${count}件)`);

  investmentList.sort((a, b) => b.oku - a.oku);
  const investEl = document.getElementById("breakdown-investments");
  investEl.innerHTML = "";
  if (investmentList.length === 0) {
    investEl.innerHTML = `<li class="empty">データなし</li>`;
  } else {
    for (const inv of investmentList.slice(0, 5)) {
      const li = document.createElement("li");
      li.textContent = `${inv.text}  ${inv.headline}`;
      li.addEventListener("click", () => selectArticle(inv.id));
      investEl.appendChild(li);
    }
  }
}

function renderBreakdownList(elId, entries, formatter) {
  const el = document.getElementById(elId);
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

function starString(n) {
  return "★".repeat(n) + "☆".repeat(5 - n);
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
    const li = document.createElement("li");
    li.className = "sales-card" + (a.id === state.selectedId ? " active" : "");
    li.addEventListener("click", () => selectArticle(a.id));

    const badges = [
      ...(a.companies || []).map(c => `<span class="badge badge-company">${escapeHtml(c)}</span>`),
      ...(a.regions || []).map(r => `<span class="badge badge-region">${escapeHtml(r)}</span>`),
      ...(a.dealTypes || []).map(d => `<span class="badge badge-deal">${escapeHtml(d)}</span>`)
    ].join("");

    const investText = (a.investments || []).map(i => i.text).join(" / ");
    const isSelected = a.id === state.selectedId;

    const keySentencesHtml = (a.keySentences || []).map(s => `<li>${escapeHtml(s)}</li>`).join("");

    // タップ前でも内容がイメージできるよう、重要文を全て(折りたたみ時も)プレビュー表示する
    const previewHtml =
      !isSelected && keySentencesHtml
        ? `<ul class="card-preview">${keySentencesHtml}</ul>`
        : "";

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
            <strong>全文</strong>
            <div class="body-text">${escapeHtml(a.body)}</div>
          </div>
          ${keySentencesHtml ? `<div class="detail-section"><strong>重要文</strong><ul>${keySentencesHtml}</ul></div>` : ""}
          <div class="detail-section">
            <strong>企業:</strong> ${(a.companies || []).join("、") || "なし"}<br>
            <strong>地域:</strong> ${(a.regions || []).join("、") || "なし"}<br>
            <strong>投資額:</strong> ${(a.investments || []).map(i => i.text).join("、") || "なし"}<br>
            <strong>案件種別:</strong> ${(a.dealTypes || []).join("、") || "なし"}
          </div>
          <div class="detail-section">
            <button class="btn-show-pdf btn-secondary" data-id="${a.id}">
              ${isPdfViewOpen ? "元のPDFを閉じる" : `元のPDFページを見る (p.${a.sourcePdfPage || "?"})`}
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
      <div class="card-stars">${starString(a.impactScore || 1)}</div>
      ${investText ? `<div class="card-invest">${escapeHtml(investText)}</div>` : ""}
      ${previewHtml}
      <div class="card-badges">${badges}</div>
      <div class="card-meta">p.${a.pageNumber} ・ ${a.sourceMethod === "ocr" ? "OCR" : a.sourceMethod === "text" ? "テキスト抽出" : "抽出不可"} ・ タップで${isSelected ? "折りたたむ" : "全文表示"}</div>
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

function renderDetail() {
  const detailEl = document.getElementById("article-detail");
  const a = state.articles.find(x => x.id === state.selectedId);
  if (!a) {
    detailEl.innerHTML = `<p class="empty">記事を選択してください</p>`;
    return;
  }

  const keySentencesHtml = (a.keySentences || []).map(s => `<li>${escapeHtml(s)}</li>`).join("");

  detailEl.innerHTML = `
    <h3>${escapeHtml(a.headline)}</h3>
    <div class="detail-meta">
      p.${a.pageNumber} ・ 営業インパクト ${starString(a.impactScore || 1)} ・
      取込日時: ${new Date(a.createdAt).toLocaleString("ja-JP")}
    </div>
    <div class="detail-section">
      <strong>全文</strong>
      <div class="body-text">${escapeHtml(a.body)}</div>
    </div>
    ${keySentencesHtml ? `<div class="detail-section"><strong>重要文</strong><ul>${keySentencesHtml}</ul></div>` : ""}
    <div class="detail-section">
      <strong>企業:</strong> ${(a.companies || []).join("、") || "なし"}<br>
      <strong>地域:</strong> ${(a.regions || []).join("、") || "なし"}<br>
      <strong>投資額:</strong> ${(a.investments || []).map(i => i.text).join("、") || "なし"}<br>
      <strong>案件種別:</strong> ${(a.dealTypes || []).join("、") || "なし"}
    </div>
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

async function handleShowPdfPage(article) {
  const id = article.id;

  // 既に開いていれば閉じる(トグル)
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

  if (!article.pdfId || !article.sourcePdfPage) {
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
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/",
      cMapPacked: true
    }).promise;

    // 記事がページの区切りをまたいで後半が切れることがあるため、
    // 現在のページに続けて次のページも一緒にレンダリングする。
    const startPage = Math.min(Math.max(1, article.sourcePdfPage), pdf.numPages);
    const pageNumsToRender = [startPage];
    if (startPage + 1 <= pdf.numPages) pageNumsToRender.push(startPage + 1);

    const images = [];
    for (const pageNum of pageNumsToRender) {
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
