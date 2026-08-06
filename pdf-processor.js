/**
 * pdf-processor.js (Ver.6)
 * PDFの各ページから「正確なテキスト」と「記事区切り判断用の画像」の
 * 両方を取得する。
 *
 * テキストはpdf.jsの埋め込みテキスト抽出機能(page.getTextContent)を使う。
 * OCRではなく、PDFの中に実際に存在する文字データをそのまま取り出すため、
 * 誤字が原理的に発生しない(OCRより正確)。
 *
 * 画像は保存はせず、Geminiに「どこからどこまでが1つの記事か」を
 * 判断してもらうための一時データとして使う。
 */

const PdfProcessor = (() => {
  /**
   * @param {File} file
   * @param {function} onProgress (current, total) => void
   * @param {number} scale  画質(大きいほど鮮明だが送信データ量が増える)
   */
  async function renderAllPages(file, onProgress, scale = 1.3) {
    if (typeof pdfjsLib === "undefined") {
      throw new Error(
        "pdf.jsライブラリが読み込まれていません。通信環境を確認してページを再読み込みしてください。"
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    // 日本語のCIDフォント(Adobe-Japan1)を含むPDFはCMap定義がないと
    // 本文が正しく取得できない(空白・文字化けになる)。cMapUrlの指定が必須。
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/",
      cMapPacked: true
    }).promise;
    const total = pdf.numPages;
    const pages = []; // [{ pageNum, dataUrl, text }]

    for (let i = 1; i <= total; i++) {
      onProgress && onProgress(i, total);
      const page = await pdf.getPage(i);

      // 1. 正確なテキストを抽出(OCR不要、PDF内の実データをそのまま取得)
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join("\n");

      // 2. 記事区切り判断用の画像(保存はしない一時データ)
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      canvas.width = 0;
      canvas.height = 0;

      pages.push({ pageNum: i, dataUrl, text });
    }

    return { pages, totalPages: total };
  }

  return { renderAllPages };
})();
