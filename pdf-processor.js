/**
 * pdf-processor.js (Ver.5)
 * PDFの各ページをそのまま画像化するだけ。テキスト抽出やOCRは行わない。
 * 記事の認識・要約はGemini(画像を直接読める)に任せる。
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
    // 本文が正しく描画されない(空白になる)。cMapUrlの指定が必須。
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/",
      cMapPacked: true
    }).promise;
    const total = pdf.numPages;
    const images = [];

    for (let i = 1; i <= total; i++) {
      onProgress && onProgress(i, total);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push({ pageNum: i, dataUrl: canvas.toDataURL("image/jpeg", 0.72) });
      canvas.width = 0;
      canvas.height = 0;
    }

    return { images, totalPages: total };
  }

  return { renderAllPages };
})();
