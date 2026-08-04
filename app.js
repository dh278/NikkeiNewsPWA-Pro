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
  selectedDate: "", // "" = すべての日付
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
  const cfg = GithubStore.getConfig();
  document.getElementById("input-github-token").value = GithubStore.getToken();
  document.getElementById("input-github-owner").value = (cfg && cfg.owner) || "";
  document.getElementById("input-github-repo").value = (cfg && cfg.currentRepo) || "";
  panelSettings.classList.remove("hidden");
});
document.getElementById("btn-close-settings").addEventListener("click", () => {
  panelSettings.classList.add("hidden");
});
document.getElementById("btn-save-key").addEventListener("click", () => {
  const key = document.getElementById("input-gemini-key").value.trim();
  setGeminiKey(key);

  const token = document.getElementById("input-github-token").value.trim();
  const owner = document.getElementById("input-github-owner").value.trim();
  const repo = document.getElementById("input-github-repo").value.trim();
  GithubStore.setToken(token);
  if (owner && repo) {
    const prevCfg = GithubStore.getConfig();
    GithubStore.setConfig({
      owner,
      currentRepo: repo,
      archivedRepos: (prevCfg && prevCfg.archivedRepos) || [],
    });
  }

  const status = document.getElementById("key-status");
  status.textContent = "保存しました。";
  status.className = "status ok";
});

// ---------- PDF取込 → Gemini抽出(一括) ----------

const inputPdf = document.getElementById("input-pdf");
const progressWrap = document.getElementById("ocr-progress");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");

// ファイル名(例: 260804新聞.pdf)から日付を推定する。見つからなければ今日の日付。
function parseDateFromFilename(filename) {
  const m = (filename || "").match(/(\d{2})(\d{2})(\d{2})/);
  if (m) {
    const [, yy, mm, dd] = m;
    const yyyy = 2000 + parseInt(yy, 10);
    const mmNum = parseInt(mm, 10);
    const ddNum = parseInt(dd, 10);
    if (mmNum >= 1 && mmNum <= 12 && ddNum >= 1 && ddNum <= 31) {
      return `${yyyy}-${String(mmNum).padStart(2, "0")}-${String(ddNum).padStart(2, "0")}`;
    }
  }
  return new Date().toISOString().slice(0, 10);
}

inputPdf.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const apiKey = getGeminiKey();
  if (!apiKey) {
    alert("設定画面でGoogle Gemini APIキーを登録してください。");
    inputPdf.value = "";
    return;
  }

  const newspaperDate = parseDateFromFilename(file.name);

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

    // 3. 各記事に、元ページの画像と新聞の日付をそのまま持たせる。
    //    記事本文が次ページへ続いていて見切れることがあるため、
    //    見出しのあるページに加えて次ページの画像も一緒に持たせておく。
    const imageByPage = {};
    for (const img of images) imageByPage[img.pageNum] = img.dataUrl;

    const analyzed = rawArticles.map((a) => {
      const pageImages = [];
      if (imageByPage[a.page]) pageImages.push({ pageNum: a.page, dataUrl: imageByPage[a.page] });
      if (imageByPage[a.page + 1]) pageImages.push({ pageNum: a.page + 1, dataUrl: imageByPage[a.page + 1] });

      return {
        id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        favorite: false,
        createdAt: new Date().toISOString(),
        pdfId,
        newspaperDate,
        pageNumber: a.page,
        headline: a.headline || "(見出し不明)",
        isRawArticle: !!a.isRaw,
        summary: a.summary || "",
        history: a.history || "",
        pageImages,
      };
    });

    await NikkeiDB.bulkAdd(analyzed);
    state.articles = [...analyzed, ...state.articles];
    updateDateOptions();
    render();

    const failCount = (rawArticles.failedBatches || []).length;
    let statusMsg = failCount
      ? `完了: ${analyzed.length}件抽出(一部${failCount}バッチが混雑等で失敗。再取込で再挑戦できます)`
      : `完了: ${analyzed.length}件の記事を抽出しました(全${totalPages}ページ)`;

    // GitHubにテキストデータをバックアップ保存(画像は含めない)
    if (GithubStore.isConfigured()) {
      try {
        progressLabel.textContent = statusMsg + " / GitHubへ保存中...";
        await GithubStore.saveDayArticles(newspaperDate, analyzed);
        const rotateResult = await GithubStore.checkAndRotateIfNeeded();
        if (rotateResult.rotated) {
          statusMsg += ` ⚠️リポジトリ容量が上限に近づいたため、新しいリポジトリ「${rotateResult.newRepo}」に自動で切り替えました。`;
        }
        await updateGithubStatus();
      } catch (ghErr) {
        console.error("GitHub保存エラー:", ghErr);
        statusMsg += ` (GitHub保存は失敗: ${ghErr.message})`;
      }
    }
    progressLabel.textContent = statusMsg;
  } catch (err) {
    console.error(err);
    progressLabel.textContent = "エラー: " + err.message;
  } finally {
    inputPdf.value = "";
    setTimeout(() => progressWrap.classList.add("hidden"), 5000);
  }
});

// ---------- 検索・日付ジャンプ ----------

document.getElementById("input-search").addEventListener("input", (e) => {
  state.searchQuery = e.target.value.trim().toLowerCase();
  renderList();
});
document.getElementById("filter-fav-only").addEventListener("change", (e) => {
  state.favOnly = e.target.checked;
  renderList();
});

const selectDate = document.getElementById("select-date");
selectDate.addEventListener("change", (e) => {
  state.selectedDate = e.target.value;
  renderList();
  // その日の記事一覧までスクロールして「ジャンプ」させる
  document.getElementById("article-list").closest(".panel").scrollIntoView({ behavior: "smooth", block: "start" });
});

// 取込済みの新聞の日付一覧を、日付選択プルダウンに反映する
function updateDateOptions() {
  const dates = [...new Set(state.articles.map(a => a.newspaperDate).filter(Boolean))].sort().reverse();
  const current = selectDate.value;
  selectDate.innerHTML = `<option value="">すべての日付(${state.articles.length}件)</option>`;
  for (const d of dates) {
    const count = state.articles.filter(a => a.newspaperDate === d).length;
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = `${d}(${count}件)`;
    selectDate.appendChild(opt);
  }
  // 選択中の日付がまだ有効ならそれを維持する
  if (dates.includes(current)) selectDate.value = current;
}

// ---------- 集計・フィルタ ----------

function getFilteredArticles() {
  return state.articles.filter(a => {
    if (state.favOnly && !a.favorite) return false;
    if (state.selectedDate && a.newspaperDate !== state.selectedDate) return false;
    if (!state.searchQuery) return true;
    const haystack = [a.headline, a.summary, a.history].join(" ").toLowerCase();
    return haystack.includes(state.searchQuery);
  });
}

function renderDashboard() {
  document.getElementById("stat-count").textContent = state.articles.length;
  document.getElementById("stat-fav").textContent = state.articles.filter(a => a.favorite).length;
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
            <strong>元のPDFページ${(a.pageImages || []).length > 1 ? "(次ページも含む)" : ""}</strong>
            ${(a.pageImages && a.pageImages.length)
              ? a.pageImages.map(img => `<img class="pdf-page-image" src="${img.dataUrl}" alt="元PDF p.${img.pageNum}">`).join("")
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
      <div class="card-meta">${a.newspaperDate || ""} p.${a.pageNumber} ・ タップで${isSelected ? "折りたたむ" : "全文表示"}</div>
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
    ${(a.pageImages || []).map(img => `<img class="pdf-page-image" src="${img.dataUrl}" alt="元PDF p.${img.pageNum}">`).join("")}
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

  // お気に入り状態もGitHubのバックアップに反映しておく(失敗しても致命的ではないので無視)
  if (GithubStore.isConfigured() && a.newspaperDate) {
    const sameDay = state.articles.filter(x => x.newspaperDate === a.newspaperDate);
    GithubStore.saveDayArticles(a.newspaperDate, sameDay).catch(e =>
      console.error("お気に入りのGitHub反映に失敗:", e)
    );
  }
}

// GitHubの保存容量の目安をダッシュボードに表示する
async function updateGithubStatus() {
  const el = document.getElementById("github-status");
  if (!GithubStore.isConfigured()) {
    el.classList.add("hidden");
    return;
  }
  try {
    const cfg = GithubStore.getConfig();
    const sizeKB = await GithubStore.getRepoSizeKB(cfg.owner, cfg.currentRepo);
    const sizeMB = (sizeKB / 1024).toFixed(1);
    const pct = Math.min(100, Math.round((sizeKB / (800 * 1024)) * 100));
    el.textContent = `GitHub保存: ${cfg.currentRepo} 約${sizeMB}MB使用中(800MB到達で自動的に新リポジトリへ切替 / ${pct}%)`;
    el.classList.remove("hidden");
  } catch (e) {
    console.error("GitHub容量取得エラー:", e);
  }
}

function render() {
  renderDashboard();
  renderList();
  renderDetail();
}

// ---------- 初期化 ----------

(async () => {
  state.articles = await NikkeiDB.getAll();

  // ローカル(IndexedDB)が空の場合(Safariの7日間未訪問による自動消去など)、
  // GitHubにバックアップがあればそこから復元する(画像は含まれない)
  if (state.articles.length === 0 && GithubStore.isConfigured()) {
    try {
      state.articles = await GithubStore.loadAllArticles();
    } catch (e) {
      console.error("GitHubからの復元に失敗:", e);
    }
  }

  state.articles.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  updateDateOptions();
  render();
  updateGithubStatus();
})();
