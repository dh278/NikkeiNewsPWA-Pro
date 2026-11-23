/* Reading controls, search filtering, keyword alerts and scroll restoration. */
(() => {
  "use strict";
  const KEYWORDS_KEY = "nikkei-radar-alert-keywords";
  const FONT_KEY = "nikkei-radar-font-scale";
  const SCROLL_KEY = "nikkei-radar-scroll-y";
  const MARKET_RE = /マーケット|株式市況|株式市場|東京株式|日経平均|株価指数|債券|為替|外為|商品市況|円相場|ドル円|NYダウ|ナスダック|市場概況/;
  const $ = (id) => document.getElementById(id);

  const getKeywords = () => {
    try {
      const value = JSON.parse(localStorage.getItem(KEYWORDS_KEY) || "[]");
      return Array.isArray(value) ? value.filter((word) => typeof word === "string" && word.trim()) : [];
    } catch (_) { return []; }
  };

  const getSearchQuery = () => ($("input-search-header")?.value || $("input-search")?.value || "").trim();
  const cardText = (card) => card ? card.textContent || "" : "";

  function updateKeywordNotice() {
    const notice = $("keyword-notice");
    const cards = [...($("article-list")?.querySelectorAll(".sales-card") || [])];
    if (!notice) return;
    const keywords = getKeywords();
    const matches = keywords.filter((word) => cards.some((card) => cardText(card).toLocaleLowerCase().includes(word.toLocaleLowerCase())));
    const count = cards.filter((card) => keywords.some((word) => cardText(card).toLocaleLowerCase().includes(word.toLocaleLowerCase()))).length;

    if (!matches.length || !count) {
      notice.classList.add("hidden");
      notice.textContent = "";
      return;
    }

    notice.textContent = `🔔 登録キーワードの記事 ${count}件: ${matches.join("、")}`;
    notice.classList.remove("hidden");
  }

  function readCard(card) {
    if (!card) {
      alert("読み上げる記事を選択してください。");
      return;
    }
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      alert("このブラウザーは読み上げに対応していません。");
      return;
    }

    const title = card.querySelector(".card-title")?.textContent || "";
    const text = card.querySelector(".card-expanded")?.textContent
      || card.querySelector(".card-preview")?.textContent
      || "";
    const content = [title, text].filter(Boolean).join("。");
    if (!content.trim()) {
      alert("読み上げる本文がありません。");
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = "ja-JP";
    window.speechSynthesis.speak(utterance);
  }

  function enhanceRenderedList() {
    const list = $("article-list");
    if (!list) return;

    const searching = Boolean(getSearchQuery());
    list.querySelectorAll(".sales-card").forEach((card) => {
      if (searching && MARKET_RE.test(cardText(card))) {
        card.classList.add("feature-market-hidden");
      } else {
        card.classList.remove("feature-market-hidden");
      }

      if (!card.querySelector(".feature-read-card")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "feature-read-card";
        button.textContent = "🔊 読み上げ";
        button.setAttribute("aria-label", "この記事を読み上げ");
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          readCard(card);
        });

        const meta = card.querySelector(".card-meta");
        if (meta) meta.insertAdjacentElement("afterend", button);
      }
    });

    updateKeywordNotice();
  }

  if (typeof window.renderList === "function") {
    const originalRenderList = window.renderList;
    window.renderList = function (...args) {
      const result = originalRenderList.apply(this, args);
      enhanceRenderedList();
      return result;
    };
  }

  $("feature-read-selected")?.addEventListener("click", () => {
    readCard($("article-list")?.querySelector(".sales-card.active"));
  });

  const fontButton = $("feature-font-size");
  const fontLevels = [
    { label: "Aa", value: "1" },
    { label: "115%", value: "1.15" },
    { label: "130%", value: "1.30" },
    { label: "145%", value: "1.45" }
  ];

  function applyFontScale(level) {
    const found = fontLevels.find((item) => item.value === level) || fontLevels[0];
    document.documentElement.style.setProperty("--reading-scale", found.value);
    if (fontButton) fontButton.textContent = found.label;
    localStorage.setItem(FONT_KEY, found.value);
  }

  applyFontScale(localStorage.getItem(FONT_KEY) || "1");
  fontButton?.addEventListener("click", () => {
    const current = localStorage.getItem(FONT_KEY) || "1";
    const index = Math.max(0, fontLevels.findIndex((item) => item.value === current));
    applyFontScale(fontLevels[(index + 1) % fontLevels.length].value);
  });

  $("feature-keywords")?.addEventListener("click", () => {
    const answer = prompt("通知したい企業名・キーワードを入力してください（複数はカンマ区切り）。空欄で全て削除します。", getKeywords().join(", "));
    if (answer === null) return;

    const words = [...new Set(answer.split(/[、,，]/).map((word) => word.trim()).filter(Boolean))];
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify(words));
    updateKeywordNotice();
    alert(words.length ? `通知キーワードを${words.length}件登録しました。` : "通知キーワードを削除しました。");
  });

  $("feature-scroll-top")?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("feature-scroll-bottom")?.addEventListener("click", () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  });

  let scrollTimer;
  const saveScroll = () => localStorage.setItem(SCROLL_KEY, String(window.scrollY));
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveScroll, 150);
  }, { passive: true });
  window.addEventListener("pagehide", saveScroll);

  window.addEventListener("load", () => {
    const savedY = Number(localStorage.getItem(SCROLL_KEY) || 0);
    if (savedY > 0) setTimeout(() => window.scrollTo(0, savedY), 500);
    enhanceRenderedList();
  });

})();
