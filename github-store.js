/**
 * github-store.js
 *
 * 記事のテキストデータ(見出し・要約・過去の関連動向・日付・ページ番号・
 * お気に入り・人事/データ表フラグ)を、GitHubリポジトリ内に
 *   data/YYYY-MM-DD.json
 * として保存する。SafariのITP(7日間未訪問でIndexedDBごと消える仕様)や
 * 端末の入れ替えに影響されない、永続的なバックアップ先として使う。
 *
 * 元PDFページの画像はサイズが大きいため対象外(IndexedDBのみで保持)。
 * 画像が消えても、再取込すれば復元できるので実害は小さい。
 *
 * 【容量オーバー時の自動リポジトリ切り替え】
 * GitHubは1リポジトリ1GB程度を推奨上限としているため、現在のリポジトリの
 * サイズが800MB(1GBの8割)を超えたら、新しいリポジトリを自動作成して
 * 書き込み先を切り替える。古いリポジトリは読み取り専用のアーカイブとして
 * 引き続き参照する。
 */

const GithubStore = (() => {
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
    const res = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
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
  };
})();
