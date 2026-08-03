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

    // まず全ページ分のテキスト/セグメントを集める。
    // このPDFの「ページ」はブラウザの印刷機能によるたまたまの区切りであり、
    // 記事の途中で区切られることがあるため、ページ単位で記事分割すると
    // 境目をまたぐ記事の見出しと本文がズレてしまう。そのため分割は
    // 全ページ分のテキストをつなげた後にまとめて行う。
    const pages = []; // {pageNumber, fullText, segments, method}
    let ocrPageCount = 0;
    let textPageCount = 0;
    const noTextPages = [];

    for (let i = 1; i <= total; i++) {
      onProgress && onProgress(i, total, "テキスト抽出中");
      const page = await pdf.getPage(i);

      const { segments: textSegments, fullText } = await extractPageText(page);
      let segments;
      let method;
      let pageFullText = fullText;

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
        pageFullText = (visionResult.fullTextAnnotation && visionResult.fullTextAnnotation.text) || "";
        method = "ocr";
        ocrPageCount++;
      } else {
        noTextPages.push(i);
        continue;
      }

      pages.push({ pageNumber: i, fullText: pageFullText, segments, method });
    }

    const rawArticles = [];

    // 全ページ結合後の文字列中で、各ページのテキストがどこから始まるかを記録しておく。
    // 記事分割後、書誌情報行の位置(metaStart)からこのオフセット表を逆引きすれば、
    // 「元のPDFの何ページ目付近にあった記事か」がわかる(＝元PDFジャンプ機能に使う)。
    let cursor = 0;
    const pageOffsets = pages.map(p => {
      const offset = cursor;
      cursor += p.fullText.length + 1; // +1 は join("\n") の区切り文字ぶん
      return { pdfPageIndex: p.pageNumber, offset };
    });

    function findPdfPageIndex(charPos) {
      let found = pages.length ? pages[0].pageNumber : 1;
      for (const po of pageOffsets) {
        if (po.offset <= charPos) found = po.pdfPageIndex;
        else break;
      }
      return found;
    }

    // 日経電子版の「印刷用ページ」形式(書誌情報行に文字数が明記されている)なら
    // 文字数ぴったりで記事を切り出せる高精度パーサーを、文書全体に対して一度だけ実行する。
    // 該当しないPDF(紙面のスキャン等)ではnullが返るので、その場合のみ
    // ページごとに見出しサイズのヒューリスティックへフォールバックする。
    const documentFullText = pages.map(p => p.fullText).join("\n");
    const indexedArticles = NikkeiIndexParser.parse(documentFullText);

    if (indexedArticles) {
      for (const { metaStart, ...a } of indexedArticles) {
        rawArticles.push({
          ...a,
          sourceMethod: "text",
          sourcePdfPage: findPdfPageIndex(metaStart)
        });
      }
    } else {
      for (const p of pages) {
        const pageArticles = SegmentUtils.groupSegmentsIntoArticles(p.segments, p.pageNumber);
        for (const a of pageArticles) {
          rawArticles.push({ ...a, sourceMethod: p.method, sourcePdfPage: p.pageNumber });
        }
      }
    }

    for (const pageNo of noTextPages) {
      rawArticles.push({
        headline: `(テキスト抽出不可) p.${pageNo}`,
        body: "このページは通常のテキスト抽出ができず、Google Vision APIキーも未設定のため内容を取得できませんでした。設定画面でAPIキーを登録すると自動でOCR処理されます。",
        pageNumber: pageNo,
        sourceMethod: "none"
      });
    }

    return { rawArticles, totalPages: total, ocrPageCount, textPageCount };
  }

  return { processPdf, isTextSufficient };
})();
