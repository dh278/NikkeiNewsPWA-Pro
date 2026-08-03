/**
 * gemini-extract.js
 * PDFページの画像をGemini APIに送り、紙面に載っている記事を
 * 見出し＋300字程度の要約＋登場企業名のJSONとして丸ごと抽出する。
 * OCRや自作の記事分割ロジックを持たず、画像理解をGeminiにそのまま任せる設計。
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

各ページに掲載されている記事を、大小・種類を問わず全て抽出してください。
・大きな主要ニュース記事
・短信(数行だけの短いニュース)
・人事異動のお知らせ
・株価やマーケットの数表(個別記事にできないので、そのページ全体の傾向を1件として簡潔にまとめる)
・文化面・生活面の連載やコラム
これら全てを漏れなく対象にしてください。

同じ記事が複数ページにまたがっている場合は、見出しだけがあるページではなく、
実際に本文が書かれているページ番号を報告してください。

出力は次のJSON配列のみとしてください。前置き・説明・マークダウンのコードブロック記法は
一切不要です。JSON以外の文字を含めないでください。

[
  {
    "page": <この記事が載っているPDFページ番号(数値)>,
    "headline": "<記事の見出し>",
    "summary": "<300文字程度の日本語要約>",
    "companies": ["<記事に登場する企業名(複数可、なければ空配列)>"]
  }
]
`.trim();

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
          generationConfig: { temperature: 0.2 }
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
    for (let i = 0; i < batches.length; i++) {
      onProgress && onProgress(i + 1, batches.length);
      const batchResult = await extractBatch(batches[i], apiKey);
      results.push(...batchResult);
    }
    return results;
  }

  return { extractAll };
})();
