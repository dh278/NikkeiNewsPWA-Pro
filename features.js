/* Progressive enhancements for reading, keyword alerts, accessibility and scroll restore. */
(() => {
  "use strict";
  const KEYWORDS_KEY = "nikkei-radar-alert-keywords";
  const FONT_KEY = "nikkei-radar-font-scale";
  const SCROLL_KEY = "nikkei-radar-scroll-y";
  const MARKET_RE = /マーケット|株式市況|株式市場|東京株式|日経平均|株価指数|債券|為替|外為|商品市況|円相場|ドル円|NYダウ|ナスダック|市場概況/;
  const $ = (id) => document.getElementById(id);
  const getKeywords = () => {
    try { return JSON.parse(localStorage.getItem(KEYWORDS_KEY) || "[]").filter(Boolean); }
    catch (_) { return []; }
  };
  const articleText = (a) => [a.headline, a.summary, a.history, a.fullText].filter(Boolean).join(" ");
  const isMarketArticle = (a) => Boolean(a && MARKET_RE.test(articleText(a)));

  const originalGetFilteredArticles = window.getFilteredArticles;
  if (typeof originalGetFilteredArticles === "function") {
    window.getFilteredArticles = function () {
      const articles = originalGetFilteredArticles();
      const query = window.state && window.state.searchQuery;
      return query ? articles.filter((a) => !isMarketArticle(a)) : articles;
    };
  }

  function updateKeywordNotice() {
    const notice = $("keyword-notice");
    if (!notice || !window.state) return;
    const keywords = getKeywords();
    const matching = (window.state.articles || []).filter((a) => {
      const text = articleText(a).toLocaleLowerCase();
      return keywords.some((word) => text.includes(word.toLocaleLowerCase()));
    });
    if (!keywords.length || !matching.length) {
      notice.classList.add("hidden");
      notice.textContent = "";
      return;
    }
    const names = [...new Set(keywords.filter((word) =>
      matching.some((a) => articleText(a).toLocaleLowerCase().includes(word.toLocaleLowerCase()))
    ))];
    notice.textContent = `🔔 登録キーワードの記事 ${matching.length}件: ${names.join("、")}`;
    notice.classList.remove("hidden");
  }

  function readArticle(article) {
    if (!article) { alert("読み上げる記事を選択してください。"); return; }
    if (!("speechSynthesis" in window)) { alert("このブラウザーは読み上げに対応していません。"); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance([article.headline, article.summary || article.fullText].filter(Boolean).join("。"));
    utterance.lang = "ja-JP";
    window.speechSynthesis.speak(utterance);
  }

  function addCardReadButtons() {
    const list = $("article-list");
    if (!list || !window.state) return;
    list.querySelectorAll(".sales-card").forEach((card) => {
      if (card.querySelector(".feature-read-card")) return;
      const title = card.querySelector(".card-title");
      const article = (window.state.articles || []).find((a) => a.headline === (title && title.textContent));
      if (!article) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "feature-read-card";
      button.textContent = "🔊 読み上げ";
      button.addEventListener("click", (event) => { event.stopPropagation(); readArticle(article); });
      const meta = card.querySelector(".card-meta");
      if (meta) meta.insertAdjacentElement("afterend", button);
    });
  }

  const originalRenderList = window.renderList;
  if (typeof originalRenderList === "function") {
    window.renderList = function () {
      originalRenderList();
      addCardReadButtons();
      updateKeywordNotice();
    };
  }

  $("feature-read-selected")?.addEventListener("click", () => {
    const selected = window.state && (window.state.articles || []).find((a) => a.id === window.state.selectedId);
    readArticle(selected);
  });

  $("feature-font-size")?.addEventListener("click", () => {
    const levels = ["100%", "115%", "130%", "145%"];
    const current = localStorage.getItem(FONT_KEY) || "100%";
    const next = levels[(levels.indexOf(current) + 1) % levels.length];
    document.documentElement.style.setProperty("--reading-scale", next);
    localStorage.setItem(FONT_KEY, next);
    $("feature-font-size").textContent = next === "100%" ? "Aa" : next;
  });
  const savedScale = localStorage.getItem(FONT_KEY) || "100%";
  document.documentElement.style.setProperty("--reading-scale", savedScale);
  if ($("feature-font-size") && savedScale !== "100%") $("feature-font-size").textContent = savedScale;

  $("feature-keywords")?.addEventListener("click", () => {
    const current = getKeywords();
    const answer = prompt("通知したい企業名・キーワードを入力してください（複数はカンマ区切り）", current.join(", "));
    if (answer === null) return;
    const words = [...new Set(answer.split(/[、,，]/).map((w) => w.trim()).filter(Boolean))];
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(words));
    updateKeywordNotice();
    alert(words.length ? `通知キーワードを${words.length}件登録しました。` : "通知キーワードを削除しました。");
  });

  $("feature-scroll-top")?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  $("feature-scroll-bottom")?.addEventListener("click", () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));

  let scrollTimer;
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => localStorage.setItem(SCROLL_KEY, String(window.scrollY)), 150);
  }, { passive: true });
  window.addEventListener("pagehide", () => localStorage.setItem(SCROLL_KEY, String(window.scrollY)));
  window.addEventListener("load", () => {
    const savedY = Number(localStorage.getItem(SCROLL_KEY) || 0);
    if (savedY > 0) setTimeout(() => window.scrollTo(0, savedY), 500);
    updateKeywordNotice();
    addCardReadButtons();
  });
})();
