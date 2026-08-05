/**
 * app.js (Ver.5)
 *
 * 処理の流れ:
 *   1. PdfProcessor.renderAllPages()  … PDFの全ページを画像化するだけ
 *   2. GeminiExtract.extractAll()     … 画像から記事認識+500字要約+
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

document.getElementById("btn-test-github").addEventListener("click", async () => {
  // テスト前に、今入力欄にある内容を先に保存しておく(保存し忘れたままのテストを防ぐ)
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
  status.textContent = "接続テスト中...";
  status.className = "status";

  try {
    const result = await GithubStore.testConnection();
    status.textContent = result.message;
    status.className = "status " + (result.ok ? "ok" : "error");
  } catch (e) {
    status.textContent = `接続テストでエラーが発生しました: [${e.name}] ${e.message}`;
    status.className = "status error";
  }
});

// ---------- PDF取込 → Gemini抽出(一括) ----------

const inputPdf = document.getElementById("input-pdf");
const progressWrap = document.getElementById("ocr-progress");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");

// GitHubへのバックアップ用に、画質・サイズを落とした軽量JPEGを作る
// (Gemini解析用・ローカル表示用の高画質版とは別に、バックアップ専用の軽量版を作る)
function compressForBackup(dataUrl, maxWidth = 900, quality = 0.5) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
      canvas.width = 0;
      canvas.height = 0;
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ファイル名(例: 260804新聞.pdf)から日付を推定する。見つからなければ今日の日付。
function parseDateFromFilename(filename) {  const m = (filename || "").match(/(\d{2})(\d{2})(\d{2})/);
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

    // 2. Geminiに画像を渡して、記事の認識+500字要約+過去の関連動向を一括生成
    const rawArticles = await GeminiExtract.extractAll(images, apiKey, (curBatch, totalBatches) => {
      const pct = 50 + Math.round((curBatch / totalBatches) * 50); // 後半50%をGemini処理に割り当て
      progressFill.style.width = pct + "%";
      progressLabel.textContent = `Geminiで記事を解析中... (${curBatch}/${totalBatches}バッチ)`;
    });

    // 3. 各記事は、元ページの番号(current, 次ページ)だけを持つ。
    //    画像そのものは記事に埋め込まず、ページ単位で1回だけ別途保存する
    //    (同じページを複数記事が参照しても重複保存しないため)。
    const pageNumSet = new Set(images.map(img => img.pageNum));

    const analyzed = rawArticles.map((a) => {
      const pageNumbers = [a.page];
      if (pageNumSet.has(a.page + 1)) pageNumbers.push(a.page + 1);

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
        pageNumbers,
      };
    });

    // ページ画像はローカル(IndexedDB)にページ単位で1回だけ保存する
    await NikkeiDB.putPages(newspaperDate, images);

    await NikkeiDB.bulkAdd(analyzed);
    state.articles = [...analyzed, ...state.articles];
    updateDateOptions();
    render();

    const failCount = (rawArticles.failedBatches || []).length;
    let statusMsg = failCount
      ? `完了: ${analyzed.length}件抽出(一部${failCount}バッチが混雑等で失敗。再取込で再挑戦できます)`
      : `完了: ${analyzed.length}件の記事を抽出しました(全${totalPages}ページ)`;

    // GitHubにテキストデータ+圧縮したページ画像をバックアップ保存
    if (GithubStore.isConfigured()) {
      try {
        progressLabel.textContent = statusMsg + " / GitHubへ保存中...";
        await GithubStore.saveDayArticles(newspaperDate, analyzed);

        progressLabel.textContent = statusMsg + " / ページ画像をGitHubへ圧縮アップロード中...";
        const compressed = [];
        for (const img of images) {
          compressed.push({ pageNum: img.pageNum, dataUrl: await compressForBackup(img.dataUrl) });
        }
        await GithubStore.savePageImages(newspaperDate, compressed);

        const rotateResult = await GithubStore.checkAndRotateIfNeeded();
        if (rotateResult.rotated) {
          statusMsg += ` ⚠️リポジトリ容量が上限に近づいたため、新しいリポジトリ「${rotateResult.newRepo}」に自動で切り替えました。`;
        }
        await updateGithubStatus();
      } catch (ghErr) {
        console.error("GitHub保存エラー:", ghErr);
        statusMsg += ` (GitHub保存は失敗: ${ghErr.message})`;
        alert("GitHubへの保存に失敗しました:\n" + ghErr.message);
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
  selectDate.innerHTML = `<option value="">すべての日付(${state.articles.length}件)</option>`;
  for (const d of dates) {
    const count = state.articles.filter(a => a.newspaperDate === d).length;
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = `${d}(${count}件)`;
    selectDate.appendChild(opt);
  }
  // state.selectedDateを正として、プルダウンの表示をそれに合わせる
  selectDate.value = dates.includes(state.selectedDate) ? state.selectedDate : "";
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

    // AI要約(500字)と過去の関連動向を、タップ前からプレビュー表示する。
    // 要約部分だけタップすると元のPDFページを直接開く。
    let previewHtml = "";
    if (!isSelected) {
      if (a.isRawArticle) {
        previewHtml = `<p class="card-preview raw-note js-open-pdf" data-id="${a.id}">${escapeHtml((a.summary || "").slice(0, 120))}…(人事・データ表/タップで元PDF)</p>`;
      } else if (a.summary) {
        previewHtml = `
          <p class="card-preview gemini-summary js-open-pdf" data-id="${a.id}" title="タップで元のPDFページを表示">${escapeHtml(a.summary)}</p>
          ${a.history ? `<div class="detail-section history preview-history"><strong>過去の関連動向</strong><div class="body-text">${escapeHtml(a.history)}</div></div>` : ""}
        `;
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
            <strong>元のPDFページ${(a.pageNumbers || []).length > 1 ? "(次ページも含む)" : ""}</strong>
            ${renderPageImagesHtml(a)}
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// 元PDFページの<img>群を組み立てる。画像本体はGitHub上のraw URLを直接指す
// (Publicリポジトリならトークン不要で他端末からも見られる)。
// GitHub未設定、または画像がまだアップロードされていない場合はonerrorで
// プレースホルダー文言に差し替える。
function renderPageImagesHtml(a) {
  if (!GithubStore.isReadable()) {
    return `<p class="empty">設定画面でGitHubユーザー名・リポジトリ名を入力すると、ここに元PDFページが表示されます</p>`;
  }
  const pageNumbers = a.pageNumbers || (a.pageNumber ? [a.pageNumber] : []);
  if (!pageNumbers.length) {
    return `<p class="empty">元PDFページの情報がありません</p>`;
  }
  return pageNumbers
    .map(pn => {
      const url = GithubStore.getPageImageUrl(a.newspaperDate, pn);
      const placeholderId = `img-missing-${a.id}-${pn}`;
      return `
        <img class="pdf-page-image" src="${url}" alt="元PDF p.${pn}"
             onerror="this.style.display='none'; document.getElementById('${placeholderId}').style.display='block';">
        <p id="${placeholderId}" class="empty" style="display:none;">p.${pn}の画像が見つかりません(未アップロードか90日経過で削除された可能性があります)</p>
      `;
    })
    .join("");
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
  if (!GithubStore.isReadable()) {
    el.classList.add("hidden");
    return;
  }
  try {
    const cfg = GithubStore.getConfig();
    const sizeKB = await GithubStore.getRepoSizeKB(cfg.owner, cfg.currentRepo);
    const sizeMB = (sizeKB / 1024).toFixed(1);
    const pct = Math.min(100, Math.round((sizeKB / (800 * 1024)) * 100));
    const mode = GithubStore.isConfigured() ? "" : "(閲覧のみ・このデバイスにトークン未設定)";
    el.textContent = `GitHub保存: ${cfg.currentRepo} 約${sizeMB}MB使用中(800MB到達で自動的に新リポジトリへ切替 / ${pct}%) ${mode}`;
    el.classList.remove("hidden");
  } catch (e) {
    console.error("GitHub容量取得エラー:", e);
  }
}

function render() {
  renderDashboard();
  renderList();
}

// ---------- 初期化 ----------

(async () => {
  state.articles = await NikkeiDB.getAll();

  // ローカル(IndexedDB)が空の場合(Safariの7日間未訪問による自動消去、
  // または他端末での初回アクセス)、GitHubにデータがあれば読み込む
  // (閲覧だけならトークン不要。画像は含まれない=表示時にGitHubのURLを直接参照)
  if (state.articles.length === 0 && GithubStore.isReadable()) {
    try {
      state.articles = await GithubStore.loadAllArticles();
    } catch (e) {
      console.error("GitHubからの復元に失敗:", e);
    }
  }

  // 日付は新しい順、同じ日付内では紙面のページ順(1面から)に並べる
  state.articles.sort((a, b) => {
    const dateDiff = (b.newspaperDate || "").localeCompare(a.newspaperDate || "");
    if (dateDiff !== 0) return dateDiff;
    return (a.pageNumber || 0) - (b.pageNumber || 0);
  });

  // トップは「すべての記事」ではなく、一番新しい日付のニュースだけを表示する
  const availableDates = [...new Set(state.articles.map(a => a.newspaperDate).filter(Boolean))].sort().reverse();
  if (availableDates.length > 0) {
    state.selectedDate = availableDates[0];
  }

  updateDateOptions();
  render();
  updateGithubStatus();

  // 90日より古いページ画像を自動削除する(記事のテキストは残す)。
  // 画面表示をブロックしないよう、バックグラウンドで実行する。
  NikkeiDB.purgeOldPages().catch(e => console.error("ローカル画像の自動削除に失敗:", e));
  if (GithubStore.isConfigured()) {
    GithubStore.purgeOldImages().catch(e => console.error("GitHub画像の自動削除に失敗:", e));
  }
})();
