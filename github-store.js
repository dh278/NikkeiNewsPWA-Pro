/**
 * github-store.js (Ver.6)
 *
 * 記事のテキストデータ(見出し・本文全文・要約・過去の関連動向・日付・
 * ページ番号・お気に入り・人事/データ表フラグ)を、GitHubリポジトリ内に
 *   data/YYYY-MM-DD.json
 * として保存する。SafariのITP(7日間未訪問でIndexedDBごと消える仕様)や
 * 端末の入れ替えに影響されない、永続的なバックアップ先として使う。
 *
 * 記事の本文全文(fullText)を取込時に保存するため、画像は保存しない
 * (Geminiに記事の区切りを判断させる一時データとしてのみ使い、処理後は破棄)。
 * タップして展開した際は、画像ではなくfullTextを表示する。
 *
 * 【容量オーバー時の自動リポジトリ切り替え】
 * テキストのみなので通常は到達しない想定の保険として、現在のリポジトリの
 * サイズが5GB(GitHub公式推奨の10GB以内に収める安全マージン)を超えたら、
 * 新しいリポジトリを自動作成して書き込み先を切り替える。
 */

const GithubStore = (() => {
  const STORAGE_KEY_TOKEN = "nikkei-radar-github-token";
  const STORAGE_KEY_CONFIG = "nikkei-radar-github-config"; // { owner, currentRepo, archivedRepos: [] }

  const ROTATE_THRESHOLD_KB = 5 * 1024 * 1024; // 5GB(GitHub公式推奨の10GB以内に収まるよう余裕を持たせた値)

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
    // 書き込み(PDF取込・保存)に必要な条件: トークン+リポジトリ設定
    const cfg = getConfig();
    return !!(getToken() && cfg && cfg.owner && cfg.currentRepo);
  }

  // 閲覧(読み込み)だけならトークン不要(Publicリポジトリの読み取りに認証は不要なため)。
  // 他の端末では、ユーザー名とリポジトリ名だけ設定すれば閲覧できるようにするための判定。
  function isReadable() {
    const cfg = getConfig();
    return !!(cfg && cfg.owner && cfg.currentRepo);
  }

  // ---------- GitHub API 共通処理 ----------

  async function api(path, options = {}) {
    const token = getToken();
    // ヘッダーは必要最小限にする(独自ヘッダーが多いとCORSのプリフライトで
    // ブロックされる場合があるため。特にContent-Typeは本文があるPUT/POST/
    // DELETEのときだけ付ける)。
    // トークンが無い端末(閲覧専用)は、Authorizationヘッダー自体を付けない
    // 匿名リクエストとして送る(Publicリポジトリの読み取りには認証不要のため)。
    const headers = {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
   * 記事配列をその日付のファイルとして保存する。
   * 既存ファイルがあれば上書き(SHAを取得してから更新)、無ければ新規作成。
   */
  async function saveDayArticles(date, articles) {
    if (!isConfigured()) return { skipped: true };

    const cfg = getConfig();
    const path = `data/${date}.json`;
    const content = JSON.stringify({ date, articles }, null, 2);

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
        message: `update ${date} (${articles.length}件)`,
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

  /**
   * 過去にリポジトリへ保存された画像(images/フォルダ)を一括削除する
   * (設定画面の「取込済み画像を全て削除」ボタンから呼び出す想定)。
   */
  async function deleteAllImages(onProgress) {
    if (!isConfigured()) return { deleted: 0 };
    const cfg = getConfig();

    const listRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/images`);
    if (!listRes.ok) return { deleted: 0 }; // imagesフォルダが無ければ何もしない
    const dateFolders = await listRes.json();

    let deleted = 0;
    let processedFolders = 0;
    for (const folder of dateFolders) {
      if (folder.type !== "dir") continue;
      processedFolders++;
      onProgress && onProgress(processedFolders, dateFolders.length);

      const filesRes = await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/${folder.path}`);
      if (!filesRes.ok) continue;
      const files = await filesRes.json();
      for (const f of files) {
        await api(`/repos/${cfg.owner}/${cfg.currentRepo}/contents/${f.path}`, {
          method: "DELETE",
          body: JSON.stringify({ message: `delete legacy image ${f.path}`, sha: f.sha }),
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

    let text;
    if (data.content) {
      // 1MB未満のファイルは、この応答に直接base64で内容が入っている
      text = base64ToUtf8(data.content);
    } else if (data.download_url) {
      // 1MB以上のファイルはcontentが省略され、download_urlから別途取得する必要がある
      const rawRes = await fetch(data.download_url);
      if (!rawRes.ok) return [];
      text = await rawRes.text();
    } else {
      return [];
    }

    const json = JSON.parse(text);
    return json.articles || [];
  }

  async function loadAllArticles() {
    if (!isReadable()) return [];
    const cfg = getConfig();
    const repos = [cfg.currentRepo, ...(cfg.archivedRepos || [])];
    const allArticles = [];

    for (const repo of repos) {
      const listRes = await api(`/repos/${cfg.owner}/${repo}/contents/data`);
      if (!listRes.ok) {
        if (listRes.status === 403) {
          // GitHub APIの利用回数制限(未認証は1時間60回まで)に達した可能性が高い
          const errText = await listRes.text();
          throw new Error(
            `GitHub APIの利用回数上限に達した可能性があります(403)。` +
            `未認証アクセスは1時間あたり60回までのため、しばらく時間をおいて再度開いてください。詳細: ${errText}`
          );
        }
        continue; // 404等(dataフォルダがまだ無い場合など)は無視して次のリポジトリへ
      }
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
   * 現在のリポジトリが5GBを超えていたら、新しいリポジトリを自動作成して
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
    isReadable,
    saveDayArticles,
    loadAllArticles,
    checkAndRotateIfNeeded,
    getRepoSizeKB,
    deleteAllImages,
    testConnection,
  };
})();
