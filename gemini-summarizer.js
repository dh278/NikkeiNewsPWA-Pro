/**
 * gemini-summarizer.js
 *
 * 抽出済みの記事群をバッチに分割し、Google Gemini API に投げて
 *   - summary: 300文字程度の要約
 *   - history: その話題に関する「過去の関連動向」(経緯・時系列の変化)。
 *              300文字の制約とは別枠で、Geminiの一般知識を使って詳しく書く。
 * を生成させる。
 *
 * 人事異動やマーケットの数表(相場表など)は要約に向かないため、
 * クライアント側で判定して生成AIには投げず、本文をそのまま使う。
 *
 * Gemini APIはブラウザから直接fetchできる(vision-ocr.jsのGoogle Vision API
 * 呼び出しと同様の構成)。APIキーはこの端末のブラウザ内にのみ保存する。
 */

const GeminiSummarizer = (() => {
  const MODEL = "gemini-3.5-flash";
  const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const BATCH_SIZE = 6;        // 1回のリクエストでまとめて渡す記事数
  const BODY_CHAR_LIMIT = 1600; // 本文が長すぎる記事は先頭のみ渡す(トークン節約)
  const SUMMARY_CHARS = 300;
  const RETRY_LIMIT = 2;

  // ---------- 人事/データ表など要約をスキップすべき記事の判定 ----------

  function isPersonnelNotice(article) {
    return /（人事）\s*$/.test(article.headline || "");
  }

  function isNumericTable(article) {
    const body = article.body || "";
    if (body.length < 20) return false;
    const digitCount = (body.match(/[0-9０-９]/g) || []).length;
    return digitCount / body.length > 0.25;
  }

  function shouldSkipSummary(article) {
    return isPersonnelNotice(article) || isNumericTable(article);
  }

  // ---------- Geminiへのリクエスト構築 ----------

  function buildPrompt(batch) {
    const articlesBlock = batch
      .map((a, i) => {
        const body = (a.body || "").slice(0, BODY_CHAR_LIMIT);
        return `[記事${i}]\n見出し: ${a.headline}\n本文: ${body}`;
      })
      .join("\n\n");

    return (
      "あなたは日本経済新聞の紙面を担当する編集アシスタントです。\n" +
      "以下の複数の記事それぞれについて、次の2つを作成してください。\n" +
      `1. summary: 本文の内容を${SUMMARY_CHARS}文字程度の日本語で要約したもの\n` +
      "2. history: この記事のトピックに関連する過去の経緯・以前の関連ニュース・" +
      "時系列での変化を、あなたの知識をもとに詳しく解説したもの" +
      "(文字数はsummaryとは別枠で構わないが、簡潔に要点を押さえること)。" +
      "特に関連する過去の動向が見当たらない場合は「特筆すべき過去の関連動向は見当たりません」としてください。\n\n" +
      "---記事一覧---\n" +
      articlesBlock
    );
  }

  const RESPONSE_SCHEMA = {
    type: "array",
    items: {
      type: "object",
      properties: {
        index: { type: "integer" },
        summary: { type: "string" },
        history: { type: "string" },
      },
      required: ["index", "summary", "history"],
    },
  };

  async function callGemini(apiKey, prompt) {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const json = await res.json();
    const text =
      json.candidates &&
      json.candidates[0] &&
      json.candidates[0].content &&
      json.candidates[0].content.parts &&
      json.candidates[0].content.parts[0] &&
      json.candidates[0].content.parts[0].text;

    if (!text) throw new Error("Gemini応答が空でした");
    return JSON.parse(text);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * @param {Array} articles  Extractor.analyze済みの記事配列(この配列を直接書き換える)
   * @param {string} apiKey
   * @param {function} onProgress (done, total, label) => void
   */
  async function summarizeArticles(articles, apiKey, onProgress) {
    if (!apiKey) throw new Error("Gemini APIキーが設定されていません。");

    // 要約対象と、素通し(人事・数表)対象を仕分け
    const targets = [];
    for (const a of articles) {
      if (shouldSkipSummary(a)) {
        a.geminiSummary = null;
        a.geminiHistory = null;
        a.isRawArticle = true;
      } else {
        a.isRawArticle = false;
        targets.push(a);
      }
    }

    const total = targets.length;
    let done = 0;
    onProgress && onProgress(done, total, "Gemini要約開始");

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const prompt = buildPrompt(batch);

      let lastErr = null;
      for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
        try {
          const results = await callGemini(apiKey, prompt);
          const byIndex = {};
          for (const r of results) byIndex[r.index] = r;

          batch.forEach((art, localIdx) => {
            const r = byIndex[localIdx];
            if (r) {
              art.geminiSummary = (r.summary || "").slice(0, SUMMARY_CHARS + 50);
              art.geminiHistory = r.history || "";
            } else {
              art.geminiSummary = "(要約取得失敗)";
              art.geminiHistory = "";
            }
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await sleep(1500 * (attempt + 1));
        }
      }
      if (lastErr) {
        console.error("Geminiバッチ処理失敗:", lastErr);
        batch.forEach((art) => {
          art.geminiSummary = art.geminiSummary || "(要約取得失敗: " + lastErr.message + ")";
          art.geminiHistory = art.geminiHistory || "";
        });
      }

      done += batch.length;
      onProgress && onProgress(done, total, "Gemini要約中");
      await sleep(1200); // 無料枠のレート制限対策
    }

    onProgress && onProgress(total, total, "Gemini要約完了");
    return articles;
  }

  return { summarizeArticles, shouldSkipSummary, isPersonnelNotice, isNumericTable };
})();
