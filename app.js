/**
 * app.js (Ver.6)
 *
 * 処理の流れ:
 *   1. PdfProcessor.renderAllPages()  … PDFの各ページから正確なテキストと
 *                                        画像(記事区切り判断用の一時データ)を取得
 *   2. GeminiExtract.extractAll()     … テキスト+画像から記事単位に整理し、
 *                                        本文全文(fullText)+500〜1000字要約+
 *                                        過去の関連動向を生成
 *   3. 画像は保存せず破棄する。「タップして全文表示」はfullTextを
 *      本文に近いフォントで表示するだけなので、画像を保持する必要が無い
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

document.getElementById("btn-dedupe").addEventListener("click", async () => {
  const status = document.getElementById("dedupe-status");
  const before = state.articles.length;

  // 重複キー: 日付+ページ番号+見出し が同じものを同一記事とみなす。
  // 同じキーが複数あれば、作成日時が一番新しいものだけを残す。
  const bestByKey = new Map();
  for (const a of state.articles) {
    const key = `${a.newspaperDate}_${a.pageNumber}_${a.headline}`;
    const existing = bestByKey.get(key);
    if (!existing || new Date(a.createdAt) > new Date(existing.createdAt)) {
      bestByKey.set(key, a);
    }
  }
  const deduped = [...bestByKey.values()];
  const removedCount = before - deduped.length;

  if (removedCount === 0) {
    status.textContent = "重複は見つかりませんでした。";
    status.className = "status ok";
    return;
  }

  const ok = confirm(`${removedCount}件の重複記事を削除します(${before}件 → ${deduped.length}件)。よろしいですか？`);
  if (!ok) return;

  status.textContent = "削除中...";
  status.className = "status";

  try {
    // 影響を受けた日付ごとに、ローカルを「削除してから重複排除後の分だけ入れ直す」
    const affectedDates = [...new Set(state.articles.map(a => a.newspaperDate).filter(Boolean))];
    for (const date of affectedDates) {
      await NikkeiDB.deleteByDate(date);
      const forThisDate = deduped.filter(a => a.newspaperDate === date);
      if (forThisDate.length) await NikkeiDB.bulkAdd(forThisDate);
    }

    state.articles = deduped;
    updateDateOptions();
    render();

    // GitHub側も、影響を受けた日付ぶんだけ上書き保存し直す(書き込み権限がある場合のみ)
    if (GithubStore.isConfigured()) {
      for (const date of affectedDates) {
        const forThisDate = deduped.filter(a => a.newspaperDate === date);
        if (forThisDate.length) {
          await GithubStore.saveDayArticles(date, forThisDate).catch(e =>
            console.error(`GitHub側の重複排除反映に失敗(${date}):`, e)
          );
        }
      }
    }

    status.textContent = `完了: ${removedCount}件削除しました(${before}件 → ${deduped.length}件)。`;
    status.className = "status ok";
  } catch (e) {
    console.error(e);
    status.textContent = "削除中にエラーが発生しました: " + e.message;
    status.className = "status error";
  }
});

document.getElementById("btn-delete-images").addEventListener("click", async () => {
  const status = document.getElementById("delete-images-status");

  if (!GithubStore.isConfigured()) {
    status.textContent = "GitHubトークンが設定された端末でのみ実行できます。";
    status.className = "status error";
    return;
  }

  const ok = confirm(
    "Ver.5以前に保存した元PDFページの画像を、GitHubリポジトリから全て削除します。\n" +
    "本文全文(fullText)を持たない古い記事は、削除後は元ページを見られなくなります。\n" +
    "よろしいですか？"
  );
  if (!ok) return;

  status.textContent = "削除中...";
  status.className = "status";

  try {
    const result = await GithubStore.deleteAllImages((cur, total) => {
      status.textContent = `削除中... (${cur}/${total}日分)`;
    });
    status.textContent = `完了: 画像${result.deleted}枚を削除しました。`;
    status.className = "status ok";
    await updateGithubStatus();
  } catch (e) {
    console.error(e);
    status.textContent = "削除中にエラーが発生しました: " + e.message;
    status.className = "status error";
  }
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
  progressLabel.textContent = "PDFからテキスト・画像を取得中...";

  try {
    const pdfId = `pdf-${Date.now()}`;

    // 1. 各ページの正確なテキスト(pdf.js抽出、OCR不要)と、
    //    記事区切り判断用の画像(保存はしない一時データ)を取得
    const { pages, totalPages } = await PdfProcessor.renderAllPages(
      file,
      (cur, total) => {
        const pct = Math.round((cur / total) * 40); // 全体の前半40%を取得処理に割り当て
        progressFill.style.width = pct + "%";
        progressLabel.textContent = `PDFからテキスト・画像を取得中... (${cur}/${total}ページ)`;
      }
    );

    // 2. Geminiにテキスト+画像を渡して、記事単位に整理させる
    //    (fullText=本文全文、summary=500〜1000字要約、history=過去の関連動向)
    const rawArticles = await GeminiExtract.extractAll(pages, apiKey, (curBatch, totalBatches) => {
      const pct = 40 + Math.round((curBatch / totalBatches) * 60); // 残り60%をGemini処理に割り当て
      progressFill.style.width = pct + "%";
      progressLabel.textContent = `Geminiで記事を整理中... (${curBatch}/${totalBatches}バッチ)`;
    });

    // 3. 記事データを組み立てる(画像は保持しない。fullTextが正本として残る)
    const analyzed = rawArticles.map((a) => ({
      id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      favorite: false,
      createdAt: new Date().toISOString(),
      pdfId,
      newspaperDate,
      pageNumber: a.page,
      headline: a.headline || "(見出し不明)",
      isRawArticle: !!a.isRaw,
      fullText: a.fullText || "",
      summary: a.summary || "",
      history: a.history || "",
    }));

    // 同じ日付のPDFを再取込した場合、古い記事(前回分)を残したまま追加すると
    // 重複してしまうため、保存前にその日付の既存記事を削除しておく
    await NikkeiDB.deleteByDate(newspaperDate);
    state.articles = state.articles.filter(a => a.newspaperDate !== newspaperDate);

    await NikkeiDB.bulkAdd(analyzed);
    state.articles = [...analyzed, ...state.articles];
    updateDateOptions();
    render();

    const failedBatches = rawArticles.failedBatches || [];
    let statusMsg = failedBatches.length
      ? `完了: ${analyzed.length}件抽出(自動再試行後もp.${failedBatches.flatMap(f => f.pages).join(",")}が混雑等で失敗。再取込で再挑戦できます)`
      : `完了: ${analyzed.length}件の記事を抽出しました(全${totalPages}ページ)`;

    // GitHubにテキストデータをバックアップ保存(画像は保存しない)
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

// ヘッダーの検索窓と、検索パネル内の検索窓は同じ検索条件を共有する。
// どちらに入力しても、もう片方の表示値も揃える。
const inputSearchHeader = document.getElementById("input-search-header");
const inputSearchPanel = document.getElementById("input-search");

function handleSearchInput(value) {
  state.searchQuery = value.trim().toLowerCase();
  inputSearchHeader.value = value;
  inputSearchPanel.value = value;
  renderList();
}

inputSearchHeader.addEventListener("input", (e) => handleSearchInput(e.target.value));
inputSearchPanel.addEventListener("input", (e) => handleSearchInput(e.target.value));

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
    const haystack = [a.headline, a.summary, a.history, a.fullText].join(" ").toLowerCase();
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
        previewHtml = `<p class="card-preview raw-note js-open-pdf" data-id="${a.id}">${escapeHtml((a.summary || "").slice(0, 120))}…(人事・データ表/タップで全文表示)</p>`;
      } else if (a.summary) {
        previewHtml = `
          <p class="card-preview gemini-summary js-open-pdf" data-id="${a.id}" title="タップで全文を表示">${escapeHtml(a.summary)}</p>
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
          ${renderFullTextHtml(a)}
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
// タップして展開した際の本文表示。Ver.6以降はfullText(本文全文)を
// 本文に近いフォントで表示する。Ver.5以前の記事でfullTextが無い場合のみ、
// 当時GitHubに保存した画像を試みに表示する(あれば見られる、無ければ案内文)。
function renderFullTextHtml(a) {
  if (!a.fullText) {
    return `<p class="empty">本文データがありません</p>`;
  }
  return `
    <div class="detail-section full-article-text">
      <strong>本文全文</strong>
      <div class="body-text serif">${escapeHtml(a.fullText)}</div>
    </div>
  `;
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
    const pct = Math.min(100, Math.round((sizeKB / (5 * 1024 * 1024)) * 100));
    const mode = GithubStore.isConfigured() ? "" : "(閲覧のみ・このデバイスにトークン未設定)";
    el.textContent = `GitHub保存: ${cfg.currentRepo} 約${sizeMB}MB使用中(5GB到達で自動的に新リポジトリへ切替 / ${pct}%) ${mode}`;
    el.classList.remove("hidden");
  } catch (e) {
    console.error("GitHub容量取得エラー:", e);
  }
}

function render() {
  renderDashboard();
  renderList();
}

// ---------- テキスト選択→用語調査 ----------

const btnLookupSelection = document.getElementById("btn-lookup-selection");
const lookupModal = document.getElementById("lookup-modal");
const lookupModalTitle = document.getElementById("lookup-modal-title");
const lookupModalBody = document.getElementById("lookup-modal-body");
const articleListEl = document.getElementById("article-list");

let pendingSelectedText = "";

document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : "";

  // 記事一覧の中で、かつ短すぎない選択のときだけボタンを出す
  // (誤操作防止のため、長すぎる選択も対象外にする)
  if (!text || text.length < 2 || text.length > 40) {
    btnLookupSelection.classList.add("hidden");
    return;
  }
  const anchorNode = sel.anchorNode;
  if (!anchorNode || !articleListEl.contains(anchorNode)) {
    btnLookupSelection.classList.add("hidden");
    return;
  }

  pendingSelectedText = text;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  btnLookupSelection.style.top = `${window.scrollY + rect.top - 44}px`;
  btnLookupSelection.style.left = `${window.scrollX + rect.left}px`;
  btnLookupSelection.classList.remove("hidden");
});

btnLookupSelection.addEventListener("click", async () => {
  const term = pendingSelectedText;
  btnLookupSelection.classList.add("hidden");
  if (!term) return;

  const apiKey = getGeminiKey();
  if (!apiKey) {
    alert("設定画面でGoogle Gemini APIキーを登録してください。");
    return;
  }

  lookupModalTitle.textContent = `「${term}」について`;
  lookupModalBody.innerHTML = `<p class="empty">調べています...</p>`;
  lookupModal.classList.remove("hidden");

  try {
    const result = await GeminiExtract.lookupTerm(term, apiKey);
    lookupModalBody.innerHTML = `
      <div class="detail-section history">
        <strong>過去のニュース・経緯</strong>
        <div class="body-text">${escapeHtml(result.history || "")}</div>
      </div>
      <div class="detail-section" style="margin-top:12px;">
        <strong>直近の動向・変遷</strong>
        <div class="body-text">${escapeHtml(result.recentTrend || "")}</div>
      </div>
    `;
  } catch (e) {
    console.error(e);
    lookupModalBody.innerHTML = `<p class="empty">調査に失敗しました: ${escapeHtml(e.message)}</p>`;
  }
});

document.getElementById("btn-close-lookup").addEventListener("click", () => {
  lookupModal.classList.add("hidden");
});

// ---------- 初期化 ----------

// 記事配列を並べ替え、日付の初期選択・一覧の更新・再描画までまとめて行う
function sortAndRefresh() {
  // 日付は新しい順、同じ日付内では紙面のページ順(1面から)に並べる
  state.articles.sort((a, b) => {
    const dateDiff = (b.newspaperDate || "").localeCompare(a.newspaperDate || "");
    if (dateDiff !== 0) return dateDiff;
    return (a.pageNumber || 0) - (b.pageNumber || 0);
  });

  // トップは「すべての記事」ではなく、一番新しい日付のニュースだけを表示する
  const availableDates = [...new Set(state.articles.map(a => a.newspaperDate).filter(Boolean))].sort().reverse();
  if (availableDates.length > 0 && !state.selectedDate) {
    state.selectedDate = availableDates[0];
  }

  updateDateOptions();
  render();
}

(async () => {
  // 1. まずローカル(IndexedDB)にある分だけで即座に表示する(待たせない)
  state.articles = await NikkeiDB.getAll();
  sortAndRefresh();
  updateGithubStatus();

  // 2. GitHubとの同期は裏側で行い、終わったら差分だけ追加して再描画する。
  //    iOSでは「ホーム画面に追加したPWA」と「Safariタブ」が同じURLでも
  //    ストレージ領域が別々になる仕様があり、片方だけ空/一部欠けることがある。
  //    そのため「ローカルが空の時だけ」ではなく、毎回GitHub側も確認する。
  if (GithubStore.isReadable()) {
    try {
      const remoteArticles = await GithubStore.loadAllArticles();
      const localIds = new Set(state.articles.map(a => a.id));
      const missingFromLocal = remoteArticles.filter(a => !localIds.has(a.id));
      if (missingFromLocal.length > 0) {
        state.articles = [...state.articles, ...missingFromLocal];
        // 次回以降はこの端末のローカルにも残るよう保存しておく
        await NikkeiDB.bulkAdd(missingFromLocal);
        sortAndRefresh(); // 差分があった時だけ再描画する
      }
    } catch (e) {
      console.error("GitHubとの同期に失敗:", e);
      alert("GitHubからの記事読み込みに失敗しました:\n" + e.message);
    }
  }
})();
