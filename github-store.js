/**
 * github-store.js
 *
 * 記事のテキストデータ(見出し・要約・過去の関連動向・日付・ページ番号・
 * お気に入り・人事/データ表フラグ)を、GitHubリポジトリ内に
 *   data/YYYY-MM-DD.json
 * として保存する。SafariのITP(7日間未訪問でIndexedDBごと消える仕様)や
 * 端末の入れ替えに影響されない、永続的なバックアップ先として使う。
 *
 * 元PDFページの画像も、圧縮した上で
 *   images/YYYY-MM-DD/{ページ番号}.jpg
 * として1ページ1ファイルで保存する(記事単位ではなくページ単位。
 * 同じページを複数の記事が参照しても重複保存しない)。
 * リポジトリがPublicであれば、raw.githubusercontent.com経由で
 * トークンなしに他端末からも直接閲覧できる。
 *
 * 【保存期間】
 * 画像は容量が大きいため、90日より古いものは自動的に削除する
 * (記事のテキストデータ自体は削除しない)。
 *
 * 【容量オーバー時の自動リポジトリ切り替え】
 * GitHubは1リポジトリ1GB程度を推奨上限としているため、現在のリポジトリの
 * サイズが800MB(1GBの8割)を超えたら、新しいリポジトリを自動作成して
 * 書き込み先を切り替える。古いリポジトリは読み取り専用のアーカイブとして
 * 引き続き参照する。
 */

const GithubStore = (() => {
  const IMAGE_RETENTION_DAYS = 90;
  const STORAGE_KEY_TOKEN = "nikkei-radar-github-token";
  const STORAGE_KEY_CONFIG = "nikkei-radar-github-config"; // { owner, currentRepo, archivedRepos: [] }

  const ROTATE_THRESHOLD_KB = 800 * 1024; // 800MB

  // ---------- 設定の取得・保存 ----------

  function getToken() {
    return localStorage.getItem(STORAGE_KEY_TOKEN) || "";
  }
  function setToken(token) {
    localStorage.setItem(STORAGE_KEY_TOKEN, token);
  }

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_CONFIG)) || null;
    } catch {
      return null;
    }
  }
  function setConfig(config) {
    localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
  }

  function isConfigured() {
    const cfg = getConfig();
    return !!(getToken() && cfg && cfg.owner && cfg.currentRepo);
  }

  // ---------- GitHub API 共通処理 ----------

  async function api(path, options = {}) {
    const token = getToken();
    // ヘッダーは必要最小限にする(独自ヘッダーが多いとCORSのプリフライトで
    // ブロックされる場合があるため。特にContent-Typeは本文があるPUT/POST/
    // DELETEのときだけ付ける)
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    };
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers,
    });
    return res;
  }

  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function base64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(b64)));
  }

  // ---------- 1日ぶんのデータの保存 ----------

  /**
   * 記事配列(画像フィールドは除いた軽量版)をその日付のファイルとして保存する。
   * 既存ファイルがあれば上書き(SHAを取得してから更新)、無ければ新規作成。
   */
  async function saveDayArticles(date, articles) {
    if (!isConfigured()) return { skipped: true };

    const cfg = getConfig();
    const path = `data/${date}.json`;
    const lightArticles = articles.map(({ pageImages, ...rest }) => rest); // 画像は除外
    const content = JSON.stringify({ date, articles: lightArticles }, null, 2);

    // 既存ファイルのSHAを取得(無ければ404で新規作成扱い)
    let sha = undefined;
    const getRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/${path}`);
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }

    const putRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `update ${date} (${lightArticles.length}件)`,
        content: utf8ToBase64(content),
        sha,
      }),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`GitHub保存エラー (${putRes.status}): ${errText}`);
    }

    return { skipped: false };
  }

  // ---------- ページ画像の保存(1ページ1ファイル、重複排除) ----------

  /**
   * 圧縮済みJPEGのdataUrlをページ単位で保存する。
   * 既に同じページが保存済みならスキップする(重複アップロード・容量浪費を防ぐ)。
   * @param {string} date
   * @param {Array<{pageNum, dataUrl}>} pages
   */
  async function savePageImages(date, pages) {
    if (!isConfigured()) return { skipped: true };
    const cfg = getConfig();
    let uploaded = 0;

    for (const p of pages) {
      const path = `images/${date}/${p.pageNum}.jpg`;

      // 既にあるページはスキップ(同じ日付のPDFを再取込した場合の重複防止)
      const existsRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/${path}`);
      if (existsRes.ok) continue;

      const base64 = p.dataUrl.split(",")[1];
      const putRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/${path}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `add page image ${date} p.${p.pageNum}`,
          content: base64,
        }),
      });
      if (!putRes.ok) {
        const errText = await putRes.text();
        throw new Error(`ページ画像の保存エラー p.${p.pageNum} (${putRes.status}): ${errText}`);
      }
      uploaded++;
    }
    return { skipped: false, uploaded };
  }

  /**
   * 他端末から読める、認証不要の画像URLを組み立てる(Publicリポジトリ前提)。
   * そのページが実際に存在するかは保証しない(<img>のonerrorで判定する想定)。
   */
  function getPageImageUrl(date, pageNum) {
    const cfg = getConfig();
    if (!cfg) return null;
    return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.currentRepo}/main/images/${date}/${pageNum}.jpg`;
  }

  // 90日より古いページ画像をGitHub上から削除する(記事テキストは残す)
  async function purgeOldImages() {
    if (!isConfigured()) return { deleted: 0 };
    const cfg = getConfig();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - IMAGE_RETENTION_DAYS);

    const listRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/images`);
    if (!listRes.ok) return { deleted: 0 }; // imagesフォルダが無ければ何もしない
    const dateFolders = await listRes.json();

    let deleted = 0;
    for (const folder of dateFolders) {
      if (folder.type !== "dir") continue;
      if (new Date(folder.name) >= cutoff) continue; // まだ保存期間内

      const filesRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/${folder.path}`);
      if (!filesRes.ok) continue;
      const files = await filesRes.json();
      for (const f of files) {
        await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/${f.path}`, {
          method: "DELETE",
          body: JSON.stringify({ message: `purge old image ${f.path}`, sha: f.sha }),
        });
        deleted++;
      }
    }
    return { deleted };
  }

  // ---------- 全データの読み込み(端末・IndexedDBが空のときの復元用) ----------

  async function fetchDayFile(owner, repo, filename) {
    const res = await api(`/repos/${owner}/${repo}/contents/data/${filename}`);
    if (!res.ok) return [];
    const data = await res.json();
    const json = JSON.parse(base64ToUtf8(data.content));
    return json.articles || [];
  }

  async function loadAllArticles() {
    if (!isConfigured()) return [];
    const cfg = getConfig();
    const repos = [cfg.currentRepo, ...(cfg.archivedRepos || [])];
    const allArticles = [];

    for (const repo of repos) {
      const listRes = await api(`/repos/${cfg.owner}/${repo}/contents/data`);
      if (!listRes.ok) continue; // dataフォルダがまだ無い場合など
      const files = await listRes.json();
      for (const f of files) {
        if (!f.name.endsWith(".json")) continue;
        const articles = await fetchDayFile(cfg.owner, repo, f.name);
        allArticles.push(...articles);
      }
    }
    return allArticles;
  }

  // ---------- 容量チェック・自動ローテーション ----------

  async function getRepoSizeKB(owner, repo) {
    const res = await api(`/repos/${owner}/${repo}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return data.size || 0; // KB単位
  }

  /**
   * 現在のリポジトリが800MBを超えていたら、新しいリポジトリを自動作成して
   * 書き込み先を切り替える。呼び出し側は戻り値のrotatedを見て、
   * 必要ならユーザーに通知する。
   */
  async function checkAndRotateIfNeeded() {
    if (!isConfigured()) return { rotated: false };
    const cfg = getConfig();
    const sizeKB = await getRepoSizeKB(cfg.owner, cfg.currentRepo);

    if (sizeKB < ROTATE_THRESHOLD_KB) {
      return { rotated: false, sizeKB };
    }

    // 新しいリポジトリ名: 元の名前に西暦年を足す(例: NikkeiNewsPWA-Pro-2033)
    const year = new Date().getFullYear();
    let newRepoName = `${cfg.currentRepo}-${year}`;
    let suffix = 2;
    // 念のため名前が衝突したら連番を足す
    while ((await api(`/repos/${cfg.owner}/${newRepoName}`)).ok) {
      newRepoName = `${cfg.currentRepo}-${year}-${suffix}`;
      suffix++;
    }

    const createRes = await api(`/user/repos`, {
      method: "POST",
      body: JSON.stringify({
        name: newRepoName,
        private: false,
        description: `${cfg.currentRepo}の容量上限到達により自動作成された継続リポジトリ`,
      }),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`新リポジトリの作成に失敗しました (${createRes.status}): ${errText}`);
    }

    const oldRepo = cfg.currentRepo;
    setConfig({
      owner: cfg.owner,
      currentRepo: newRepoName,
      archivedRepos: [oldRepo, ...(cfg.archivedRepos || [])],
    });

    return { rotated: true, oldRepo, newRepo: newRepoName, sizeKB };
  }

  // ---------- 接続テスト(設定画面から即座に有効性を確認するため) ----------

  /**
   * トークンが実際に有効か、認証必須のエンドポイント(/user)で確認する。
   * リポジトリの読み取り専用アクセス確認だけでは、無効なトークンでも
   * 公開リポジトリなら成功してしまうため、必ずこちらを使うこと。
   */
  async function testConnection() {
    const token = getToken();
    if (!token) return { ok: false, message: "トークンが未入力です。" };

    const cfg = getConfig();
    if (!cfg || !cfg.owner || !cfg.currentRepo) {
      return { ok: false, message: "ユーザー名またはリポジトリ名が未入力です。" };
    }

    // 1. トークン自体の有効性(認証必須のエンドポイント)
    const userRes = await api(`/user`);
    if (!userRes.ok) {
      const errText = await userRes.text();
      return { ok: false, message: `トークンが無効です (${userRes.status}): ${errText}` };
    }
    const user = await userRes.json();

    // 2. 指定されたリポジトリへの書き込み権限があるか
    const repoRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}`);
    if (!repoRes.ok) {
      const errText = await repoRes.text();
      return { ok: false, message: `リポジトリが見つかりません (${repoRes.status}): ${errText}` };
    }
    const repo = await repoRes.json();
    if (!repo.permissions || !repo.permissions.push) {
      return { ok: false, message: `トークンは有効ですが、このリポジトリへの書き込み権限がありません(閲覧のみ)。` };
    }

    return {
      ok: true,
      message: `OK: GitHubユーザー「${user.login}」として認証成功。リポジトリ「${cfg.owner}/${cfg.currentRepo}」へ書き込み可能です。`,
    };
  }

  return {
    getToken,
    setToken,
    getConfig,
    setConfig,
    isConfigured,
    saveDayArticles,
    loadAllArticles,
    checkAndRotateIfNeeded,
    getRepoSizeKB,
    savePageImages,
    getPageImageUrl,
    purgeOldImages,
    testConnection,
  };
})();
