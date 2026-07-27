const pdfInput = document.getElementById("pdfFile");
const resultArea = document.getElementById("resultArea");
const articleList = document.getElementById("articleList");

pdfInput.addEventListener("change", async (event) => {

    const file = event.target.files[0];

    if (!file) {
        return;
    }

    resultArea.innerHTML = "<p>PDFを読み込み中...</p>";

    try {

        const text = await extractTextFromPDF(file);

        const articles = splitArticles(text);

        resultArea.innerHTML =
            "<h3>抽出結果</h3>" +
            "<p>記事数：" +
            articles.length +
            "</p>";

        displayArticles(articles);

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

function splitArticles(text) {

    const lines = text
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const articles = [];

    let currentArticle = "";

    for (const line of lines) {

        if (
            line.length > 10 &&
            line.length < 80 &&
            !line.includes("日経") &&
            !line.match(/^[0-9]+$/)
        ) {

            if (currentArticle.length > 0) {
                articles.push(currentArticle);
            }

            currentArticle = line + "\n";

        } else {

            currentArticle += line + "\n";
        }
    }

    if (currentArticle.length > 0) {
        articles.push(currentArticle);
    }

    return articles;
}

function displayArticles(articles) {

    articleList.innerHTML = "";

    articles.forEach((article, index) => {

        const title =
            article.split("\n")[0];

        const card =
            document.createElement("div");

        card.style.border = "1px solid #ccc";
        card.style.padding = "10px";
        card.style.margin = "10px 0";

        card.innerHTML =
            "<strong>" +
            title +
            "</strong><br><br>" +
            "<button onclick='showArticle(" +
            index +
            ")'>全文表示</button>";

        articleList.appendChild(card);
    });

    window.articleStore = articles;
}

function showArticle(index) {

    const detail =
        document.getElementById("articleDetail");

    detail.innerHTML =
        "<pre>" +
        window.articleStore[index] +
        "</pre>";
}
