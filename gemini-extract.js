/**
 * gemini-extract.js (Ver.6)
 *
 * PDFページごとの「正確なテキスト(pdf.js抽出)」と「画像(記事区切り判断用)」を
 * Gemini APIに渡し、記事単位に整理させる。
 *
 * 重要: Geminiに文字を1から書き起こさせるのではなく、既に正確なテキストを
 * 「どこからどこまでが1つの記事か」画像を見ながら仕分け・整形させるだけの
 * 役割にすることで、精度を上げつつGemini側の負荷も抑えている。
 *
 * 人事異動やマーケットの数表(相場表など)は「要約」に向かないため、
 * 個別の記事として認識はするが要約はせず、本文をできるだけそのまま
 * (isRaw:true として)扱うようGeminiに指示する。
 */

const GeminiExtract = (() => {
  // 無料枠で継続的に使えるモデル。Googleはモデル名・無料枠の内容を
  // 頻繁に更新するため、動かない場合は https://aistudio.google.com/ で
  // 現行の無料利用可能モデル名を確認して書き換えること。
  const MODEL = "gemini-3.1-flash-lite";

  // 1回のリクエストで送るページ数。テキストも一緒に渡す分データ量が増えるため、
  // 画像のみだった頃(12)より少なめにしている。失敗が多い場合はさらに減らすこと。
  const BATCH_SIZE = 8;

  const PROMPT = `
あなたは日本経済新聞の紙面PDFを解析するアシスタントです。
これから複数ページぶんのデータを渡します。各ページについて、
「[PDFページ N テキスト]」というラベルの後にpdf.jsで抽出した正確な本文テキスト、
続けてそのページの画像(レイアウト確認用)を渡します。

渡すテキストは既にPDFから正確に抽出済みのものです。文字を新たに書き起こす
必要はありません。あなたの役割は、このテキストを画像のレイアウトを見ながら
「どこからどこまでが1つの記事か」を判断し、記事単位に仕分け・整形することです
(見出しと本文の対応付け、段落の整理など)。文字そのものを勝手に書き換えないこと。

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
4. fullText: 渡されたテキストのうち、この記事に該当する部分をそのまま整形したもの
   (要約や意訳はしない。誤字脱字の訂正程度は可)。isRawの場合も、氏名・役職や
   数表の数値などをそのまま含めること。この項目は画像を後で保持しない代わりの
   正本(バックアップ)として使うため、省略しないこと。
5. summary: isRawがfalseの場合、fullTextの内容を500文字程度の日本語で要約したもの。
   特に「誰が」「何をした結果」「どうなっている(なりつつある)のか」という、
   主体・行動・結果(現状)の流れが明確に伝わるように書くこと。単なる話題の
   紹介ではなく、具体的な当事者名と、その行動によって生じた結果・数字・
   影響を必ず盛り込むこと。
   isRawがtrueの場合はfullTextと同じ内容でよい(要約しない)。
6. history: この記事のトピックに関連する過去の経緯・以前の関連ニュース・
   時系列での変化を、あなたの知識をもとに詳しく解説したもの
   (文字数はsummaryとは別枠で構わないが、簡潔に要点を押さえること)。
   特に関連する過去の動向が見当たらない場合、またはisRawがtrueの場合は
   「特筆すべき過去の関連動向は見当たりません」としてください。

出力は次のJSON配列のみとしてください。前置き・説明・マークダウンのコードブロック記法は
一切不要です。JSON以外の文字を含めないでください。

[
  {
    "page": <数値>,
    "headline": "<見出し>",
    "isRaw": <true/false>,
    "fullText": "<この記事に該当する、整形済みの本文テキスト>",
    "summary": "<500文字程度の要約、またはisRaw時はfullTextと同内容>",
    "history": "<過去の関連動向>"
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
        fullText: { type: "string" },
        summary: { type: "string" },
        history: { type: "string" },
      },
      required: ["page", "headline", "isRaw", "fullText", "summary", "history"],
    },
  };

  /**
   * @param {Array<{pageNum, dataUrl, text}>} pageBatch
   */
  async function extractBatch(pageBatch, apiKey) {
    const parts = [{ text: PROMPT }];

    for (const { pageNum, dataUrl, text } of pageBatch) {
      parts.push({ text: `[PDFページ ${pageNum} テキスト]\n${text}` });
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

  async function extractBatchWithRetry(pageBatch, apiKey) {
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
      try {
        return await extractBatch(pageBatch, apiKey);
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
   * @param {Array<{pageNum, dataUrl, text}>} pages
   * @param {string} apiKey
   * @param {function} onProgress (currentBatch, totalBatches) => void
   */
  async function extractAll(pages, apiKey, onProgress) {
    if (!apiKey) {
      throw new Error("Gemini APIキーが未設定です。設定画面から登録してください。");
    }

    const batches = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      batches.push(pages.slice(i, i + BATCH_SIZE));
    }

    // バッチを同時に複数並行で処理し、待ち時間を短縮する。
    // 無料枠のレート制限(15req/分程度)を超えないよう、同時実行数は控えめにする。
    const CONCURRENCY = 3;

    const results = [];
    let failedBatches = [];
    let completed = 0;

    async function runBatch(batch, index) {
      try {
        const batchResult = await extractBatchWithRetry(batch, apiKey);
        results.push(...batchResult);
      } catch (e) {
        console.error(`バッチ${index + 1}が失敗しました(該当ページはスキップされます):`, e);
        failedBatches.push({ batchIndex: index, pages: batch.map(p => p.pageNum), pageBatch: batch, error: e.message });
      } finally {
        completed++;
        onProgress && onProgress(completed, batches.length);
      }
    }

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const chunk = batches.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map((batch, j) => runBatch(batch, i + j)));
    }

    // 全バッチ処理後、失敗した分だけもう一段階まとめてリトライする(こちらは並列)。
    // 「混雑」は数十秒〜数分待つと解消することが多いため、通常のバッチ間隔より
    // 長めに待ってから、まだデータがメモリに残っている失敗バッチだけを再試行する。
    if (failedBatches.length > 0) {
      console.warn(`${failedBatches.length}バッチが失敗。20秒待って再試行します...`);
      await sleep(20000);

      const retryTargets = failedBatches;
      failedBatches = [];
      for (let i = 0; i < retryTargets.length; i += CONCURRENCY) {
        const chunk = retryTargets.slice(i, i + CONCURRENCY);
        await Promise.all(
          chunk.map(async (fb) => {
            try {
              const retryResult = await extractBatchWithRetry(fb.pageBatch, apiKey);
              results.push(...retryResult);
            } catch (e) {
              console.error(`再試行後も失敗(p.${fb.pages.join(",")}):`, e);
              failedBatches.push({ ...fb, pageBatch: undefined, error: e.message });
            }
          })
        );
      }
    }

    if (failedBatches.length > 0) {
      const failedPages = failedBatches.flatMap(f => f.pages).join(", ");
      console.warn(`最終的に取得できなかったページ: ${failedPages}`);
    }
    results.failedBatches = failedBatches; // 呼び出し側でエラー内容を表示できるように
    return results;
  }

  return { extractAll };
})();
