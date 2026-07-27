const pdfInput = document.getElementById("pdfFile");
const resultArea = document.getElementById("resultArea");

pdfInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];

    if (!file) {
        return;
    }

    resultArea.innerHTML = "<p>PDFを読み込み中...</p>";

    try {
        const text = await extractTextFromPDF(file);

        resultArea.innerHTML =
            "<h3>抽出結果</h3>" +
            "<pre>" +
            text.substring(0, 5000) +
            "</pre>";

    } catch (error) {

        console.error(error);

        resultArea.innerHTML =
            "<p>PDF解析エラー: " +
            error.message +
            "</p>";
    }
});

async function extractTextFromPDF(file) {

    const buffer = await file.arrayBuffer();

    const pdf = await pdfjsLib.getDocument({
        data: buffer
    }).promise;

    let fullText = "";

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {

        const page = await pdf.getPage(pageNumber);

        const textContent =
            await page.getTextContent();

        const pageText =
            textContent.items
                .map(item => item.str)
                .join(" ");

        fullText += pageText + "\n";
    }

    return fullText;
}
