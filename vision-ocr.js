/**
 * vision-ocr.js
 * テキスト抽出に失敗したページのみ呼び出すフォールバックOCR。
 * コスト最小化のため、成功したページでは一切呼び出さない(pdf-processor.js側で制御)。
 */

const VisionOCR = (() => {

  /**
   * 1枚の画像(dataURL)をGoogle Vision APIに送ってOCRする
   * @param {string} dataUrl  "data:image/jpeg;base64,..."
   * @param {string} apiKey
   * @returns {Promise<object>} Vision APIのレスポンス(responses[0])
   */
  async function ocrImage(dataUrl, apiKey) {
    const base64 = dataUrl.split(",")[1];
    const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;

    const body = {
      requests: [
        {
          image: { content: base64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["ja"] }
        }
      ]
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Vision API error (${res.status}): ${errText}`);
    }

    const json = await res.json();
    const result = json.responses && json.responses[0];
    if (result && result.error) {
      throw new Error(`Vision API error: ${result.error.message}`);
    }
    return result || {};
  }

  return { ocrImage };
})();
