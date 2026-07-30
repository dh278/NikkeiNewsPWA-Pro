/**
 * pdf-processor.js
 * 基本方針: PDFから直接テキスト抽出。
 * ページ単位でテキストが不十分と判定された場合のみ、そのページだけ画像化してGoogle Vision OCRにフォールバック。
 * (コスト最小化: 全ページOCRではなく、必要なページのみ)
 */

const PdfProcessor = (() => {
  const MIN_TEXT_LENGTH = 30;      // これ未満の文字数なら抽出失敗とみなす
  const MIN_JAPANESE_RATIO = 0.1;  // 日本語文字の比率がこれ未満なら文字化けとみなす

  function isTextSufficient(text) {
    const trimmed = (text || "").trim();
    if (trimmed.length < MIN_TEXT_LENGTH) return false;
    const jpMatches = trimmed.match(/[\u3040-\u30ff\u4e00-\u9fff]/g);
    const ratio = jpMatches ? jpMatches.length / trimmed.length : 0;
    return ratio >= MIN_JAPANESE_RATIO;
  }

  async function extractPageText(page) {
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const segments = SegmentUtils.segmentsFromTextContent(textContent, viewport);
    const fullText = segments.map(s => s.text).join("\n");
    return { segments, fullText };
  }

  async function renderPageToDataUrl(page, scale = 2.0) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    canvas.width = 0;
    canvas.height = 0;
    return dataUrl;
  }

  /**
   * @param {File} file
   * @param {string} apiKey  空文字可(その場合OCRフォールバックは行わない)
   * @param {function} onProgress (current, total, label) => void
   */
  async function processPdf(file, apiKey, onProgress) {
    if (typeof pdfjsLib === "undefined") {
      throw new Error(
        "pdf.jsライブラリが読み込まれていません。通信環境を確認してページを再読み込みしてください。"
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    // 日本語のCIDフォント(Adobe-Japan1)を含むPDFはCMap定義がないと
    // 文字が正しく取れない(空文字や文字化けになる)。cMapUrlの指定が必須。
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/",
      cMapPacked: true
    }).promise;
    const total = pdf.numPages;

    const rawArticles = [];
    let ocrPageCount = 0;
    let textPageCount = 0;

    for (let i = 1; i <= total; i++) {
      onProgress && onProgress(i, total, "テキスト抽出中");
      const page = await pdf.getPage(i);

      const { segments: textSegments, fullText } = await extractPageText(page);
      let segments;
      let method;

      if (isTextSufficient(fullText)) {
        segments = textSegments;
        method = "text";
        textPageCount++;
      } else if (apiKey) {
        onProgress && onProgress(i, total, "OCR実行中(テキスト抽出不可のため)");
        const dataUrl = await renderPageToDataUrl(page);
        const visionResult = await VisionOCR.ocrImage(dataUrl, apiKey);
        const visionPage =
          visionResult.fullTextAnnotation && visionResult.fullTextAnnotation.pages
            ? visionResult.fullTextAnnotation.pages[0]
            : null;
        segments = visionPage ? SegmentUtils.segmentsFromVisionPage(visionPage) : [];
        method = "ocr";
        ocrPageCount++;
      } else {
        rawArticles.push({
          headline: `(テキスト抽出不可) p.${i}`,
          body: "このページは通常のテキスト抽出ができず、Google Vision APIキーも未設定のため内容を取得できませんでした。設定画面でAPIキーを登録すると自動でOCR処理されます。",
          pageNumber: i,
          sourceMethod: "none"
        });
        continue;
      }

      const pageArticles = SegmentUtils.groupSegmentsIntoArticles(segments, i);
      for (const a of pageArticles) {
        rawArticles.push({ ...a, sourceMethod: method });
      }
    }

    return { rawArticles, totalPages: total, ocrPageCount, textPageCount };
  }

  return { processPdf, isTextSufficient };
})();
