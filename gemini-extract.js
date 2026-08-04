/**
 * gemini-extract.js
 * PDFページの画像をGemini APIに送り、紙面に載っている記事を
 * 見出し＋300字程度の要約＋過去の関連動向＋登場企業名のJSONとして丸ごと抽出する。
 * OCRや自作の記事分割ロジックを持たず、画像理解をGeminiにそのまま任せる設計。
 *
 * 人事異動やマーケットの数表(相場表など)は「要約」に向かないため、
 * 個別の記事として認識はするが要約はせず、本文をできるだけそのまま
 * (isRaw:true として)書き起こすようGeminiに指示する。
 */

const GeminiExtract = (() => {
  // 無料枠で継続的に使えるモデル。Googleはモデル名・無料枠の内容を
  // 頻繁に更新するため、動かない場合は https://aistudio.google.com/ で
  // 現行の無料利用可能モデル名を確認して書き換えること。
  const MODEL = "gemini-3.1-flash-lite";

  // 1回のリクエストで送るページ数(送信データ量とトークン量を抑えるため分割する)
  const BATCH_SIZE = 12;

  const PROMPT = `
あなたは日本経済新聞の紙面PDFを解析するアシスタントです。
これから複数ページぶんの紙面画像を渡します。各画像の直前に「[PDFページ N]」という
ラベルのテキストを付けます。

今日の新聞について、1面から最終面(社会面)まで、主要ニュースだけでなく、
・短信(数行だけの短いニュース)
・人事異動のお知らせ
・株価やマーケットの数表(個別記事にできないので、そのページ全体の傾向を1件として簡潔にまとめる)
・文化面・生活面の連載やコラム
これらを含め、紙面にある全ての記事を漏れなく抽出してください。

同じ記事が複数ページにまたがっている場合は、見出しだけがあるページではなく、
実際に本文が書かれているページ番号を報告してください。

各記事について、次の項目を作成してください。
1. page: この記事が載っているPDFページ番号(数値)
2. headline: 記事の見出し
3. isRaw: 人事異動のお知らせ、またはマーケットの数表(相場表など)であれば true、
   通常の記事であれば false
4. summary: isRawがfalseの場合、本文の内容を300文字程度の日本語で要約したもの。
   isRawがtrueの場合は要約せず、本文(人事異動の氏名・役職や、数表の数値など)を
   できるだけそのまま書き起こしたもの
5. history: この記事のトピックに関連する過去の経緯・以前の関連ニュース・
   時系列での変化を、あなたの知識をもとに詳しく解説したもの
   (文字数はsummaryとは別枠で構わないが、簡潔に要点を押さえること)。
   特に関連する過去の動向が見当たらない場合、またはisRawがtrueの場合は
   「特筆すべき過去の関連動向は見当たりません」としてください。
6. companies: 記事に登場する企業名(複数可、なければ空配列)

出力は次のJSON配列のみとしてください。前置き・説明・マークダウンのコードブロック記法は
一切不要です。JSON以外の文字を含めないでください。

[
  {
    "page": <数値>,
    "headline": "<見出し>",
    "isRaw": <true/false>,
    "summary": "<300文字程度の要約、またはisRaw時はそのままの書き起こし>",
    "history": "<過去の関連動向>",
    "companies": ["<企業名>"]
  }
]
`.trim();

  const RESPONSE_SCHEMA = {
    type: "array",
    items: {
      type: "object",
      properties: {
        page: { type: "integer" },
        headline: { type: "string" },
        isRaw: { type: "boolean" },
        summary: { type: "string" },
        history: { type: "string" },
        companies: { type: "array", items: { type: "string" } },
      },
      required: ["page", "headline", "isRaw", "summary", "history", "companies"],
    },
  };

  async function extractBatch(pageImages, apiKey) {
    const parts = [{ text: PROMPT }];

    for (const { pageNum, dataUrl } of pageImages) {
      parts.push({ text: `[PDFページ ${pageNum}]` });
      parts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: dataUrl.split(",")[1]
        }
      });
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA
          }
        })
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const candidate = data.candidates && data.candidates[0];
    const text =
      (candidate && candidate.content && candidate.content.parts
        ? candidate.content.parts.map(p => p.text || "").join("")
        : "") || "";

    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error("Geminiの応答をJSONとして解析できませんでした: " + cleaned.slice(0, 300));
    }
    return Array.isArray(parsed) ? parsed : [];
  }

  const RETRY_LIMIT = 3;
  const RETRY_BASE_DELAY_MS = 3000; // 503(混雑)対策。指数的に待ち時間を伸ばす

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function extractBatchWithRetry(pageImages, apiKey) {
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
      try {
        return await extractBatch(pageImages, apiKey);
      } catch (e) {
        lastErr = e;
        // 503(混雑)・429(レート制限)は時間を置けば回復するのでリトライする
        const retriable = /50[0-9]|429/.test(e.message);
        if (!retriable || attempt === RETRY_LIMIT) break;
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /**
   * @param {Array<{pageNum, dataUrl}>} pageImages
   * @param {string} apiKey
   * @param {function} onProgress (currentBatch, totalBatches) => void
   */
  async function extractAll(pageImages, apiKey, onProgress) {
    if (!apiKey) {
      throw new Error("Gemini APIキーが未設定です。設定画面から登録してください。");
    }

    const batches = [];
    for (let i = 0; i < pageImages.length; i += BATCH_SIZE) {
      batches.push(pageImages.slice(i, i + BATCH_SIZE));
    }

    const results = [];
    const failedBatches = [];
    for (let i = 0; i < batches.length; i++) {
      onProgress && onProgress(i + 1, batches.length);
      try {
        const batchResult = await extractBatchWithRetry(batches[i], apiKey);
        results.push(...batchResult);
      } catch (e) {
        // このバッチは諦めて先へ進む(1バッチの失敗で全体を止めない)
        console.error(`バッチ${i + 1}が失敗しました(該当ページはスキップされます):`, e);
        failedBatches.push({ batchIndex: i, pages: batches[i].map(p => p.pageNum), error: e.message });
      }
    }
    if (failedBatches.length > 0) {
      const failedPages = failedBatches.flatMap(f => f.pages).join(", ");
      console.warn(`取得できなかったページ: ${failedPages}`);
    }
    results.failedBatches = failedBatches; // 呼び出し側でエラー内容を表示できるように
    return results;
  }

  return { extractAll };
})();
