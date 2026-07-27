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

        const company = extractCompanies(article);
        const region = extractRegion(article);
        const investment = extractInvestment(article);

        const impact = calculateImpact(
            article,
            company,
            region,
            investment
        );

        const title =
            article.split("\n")[0];

        const card =
            document.createElement("div");

        card.style.border = "1px solid #ccc";
        card.style.padding = "10px";
        card.style.margin = "10px 0";

        card.innerHTML =
            "<strong>" + title + "</strong><br><br>" +
            "企業: " + company + "<br>" +
            "地域: " + region + "<br>" +
            "投資額: " + investment + "<br>" +
            "営業インパクト: " + impact + "<br><br>" +
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

function extractCompanies(text) {

    const companies = [
        "FDK",
        "TDK",
        "村田製作所",
        "京セラ",
        "ローム",
        "太陽誘電",
        "アルプスアルパイン",
        "Rapidus",
        "東京電力",
        "関西電力",
        "北海道電力",
        "エヌビディア",
        "トヨタ"
    ];

    const found =
        companies.filter(company =>
            text.includes(company)
        );

    return found.length > 0
        ? found.join(", ")
        : "未検出";
}

function extractRegion(text) {

    const prefectures = [
        "北海道",
        "青森県",
        "岩手県",
        "宮城県",
        "秋田県",
        "山形県",
        "福島県",
        "東京都",
        "神奈川県",
        "埼玉県",
        "千葉県",
        "群馬県",
        "栃木県",
        "長野県",
        "静岡県",
        "愛知県",
        "大阪府",
        "京都府",
        "兵庫県",
        "福岡県"
    ];

    const found =
        prefectures.find(pref =>
            text.includes(pref)
        );

    return found || "未検出";
}

function extractInvestment(text) {

    const match =
        text.match(/([0-9０-９,]+)\s*億円/);

    if (match) {
        return match[0];
    }

    return "記載なし";
}

function calculateImpact(
    text,
    company,
    region,
    investment
) {

    let score = 0;

    if (company !== "未検出") {
        score += 20;
    }

    if (region !== "未検出") {
        score += 20;
    }

    if (investment !== "記載なし") {
        score += 40;
    }

    if (
        text.includes("工場") ||
        text.includes("建設")
    ) {
        score += 30;
    }

    if (
        text.includes("増設") ||
        text.includes("投資")
    ) {
        score += 20;
    }

    if (score >= 100) {
        return "★★★★★";
    }

    if (score >= 70) {
        return "★★★★☆";
    }

    if (score >= 40) {
        return "★★★☆☆";
    }

    return "★★☆☆☆";
}
