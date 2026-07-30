/**
 * extractor.js
 * AIを使わず、キーワード辞書・正規表現のみで
 * 企業名 / 地域 / 投資額 / 案件種別 を抽出し、重要文の上位抽出と営業インパクト(★)を算出する。
 */

const Extractor = (() => {
  let companies = [];
  let regions = [];
  let dealTypes = [];
  let loaded = false;

  async function loadData(baseUrl = "") {
    if (loaded) return;
    const [c, r, d] = await Promise.all([
      fetch(`${baseUrl}data/companies.json`).then(res => res.json()),
      fetch(`${baseUrl}data/regions.json`).then(res => res.json()),
      fetch(`${baseUrl}data/deal-types.json`).then(res => res.json())
    ]);
    companies = c;
    regions = r;
    dealTypes = d;
    loaded = true;
  }

  // ---------- 企業名抽出 ----------
  function extractCompanies(text) {
    const found = new Set();
    for (const name of companies) {
      if (text.includes(name)) found.add(name);
    }
    return [...found];
  }

  // ---------- 地域抽出 ----------
  function extractRegions(text) {
    const found = new Set();
    for (const name of regions) {
      if (text.includes(name)) found.add(name);
    }
    return [...found];
  }

  // ---------- 投資額抽出 ----------
  // 例: "500億円", "1,200億円", "1.5兆円" などを検出し、億円単位の数値に正規化する
  const AMOUNT_REGEX = /(\d{1,3}(?:[,，]\d{3})*(?:\.\d+)?)\s*(兆円|億円)/g;

  function extractInvestments(text) {
    const results = [];
    let match;
    AMOUNT_REGEX.lastIndex = 0;
    while ((match = AMOUNT_REGEX.exec(text)) !== null) {
      const numStr = match[1].replace(/[,，]/g, "");
      const num = parseFloat(numStr);
      if (isNaN(num)) continue;
      const unit = match[2];
      const oku = unit === "兆円" ? num * 10000 : num;
      results.push({ text: match[0], oku });
    }
    return results;
  }

  // ---------- 案件種別抽出 ----------
  function extractDealTypes(text) {
    const found = [];
    for (const dt of dealTypes) {
      if (dt.keywords.some(kw => text.includes(kw))) {
        found.push(dt.type);
      }
    }
    return found;
  }

  // ---------- 重要文抽出(上位3〜5文) ----------
  function extractKeySentences(text, companiesFound, regionsFound, dealTypesFound, maxSentences = 5) {
    const sentences = text
      .split(/(?<=。)/)
      .map(s => s.trim())
      .filter(s => s.length >= 8);

    if (sentences.length === 0) return [];

    const scored = sentences.map((s, idx) => {
      let score = 0;
      for (const c of companiesFound) if (s.includes(c)) score += 2;
      for (const r of regionsFound) if (s.includes(r)) score += 2;
      for (const d of dealTypesFound) score += 0; // 案件種別はキーワード自体で下でカウント
      const investMatches = s.match(AMOUNT_REGEX);
      if (investMatches) score += investMatches.length * 3;
      for (const dt of dealTypes) {
        if (dt.keywords.some(kw => s.includes(kw))) score += 1;
      }
      if (idx === 0) score += 1; // リード文ボーナス
      return { sentence: s, score, idx };
    });

    const top = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSentences)
      .sort((a, b) => a.idx - b.idx); // 元の順序に戻す

    // スコア付き文が無ければ先頭の文を返す(何も無いよりまし)
    if (top.length === 0) {
      return sentences.slice(0, Math.min(3, sentences.length));
    }
    return top.map(s => s.sentence);
  }

  // ---------- 営業インパクト(★1〜5) ----------
  function calcImpactScore(companiesFound, regionsFound, investments, dealTypesFound) {
    let score = 1; // 最低1
    if (companiesFound.length > 0) score += 1;
    if (regionsFound.length > 0) score += 1;
    if (investments.length > 0) score += 1;
    const factoryKeywords = ["工場新設", "工場増設", "設備投資"];
    if (dealTypesFound.some(t => factoryKeywords.includes(t))) score += 1;
    return Math.min(score, 5);
  }

  /**
   * 1記事分(headline+body)を分析し、抽出フィールドを付与して返す
   */
  function analyze(article) {
    const fullText = `${article.headline}\n${article.body}`;
    const companiesFound = extractCompanies(fullText);
    const regionsFound = extractRegions(fullText);
    const investments = extractInvestments(fullText);
    const dealTypesFound = extractDealTypes(fullText);
    const keySentences = extractKeySentences(
      article.body || article.headline,
      companiesFound, regionsFound, dealTypesFound
    );
    const impactScore = calcImpactScore(companiesFound, regionsFound, investments, dealTypesFound);

    return {
      ...article,
      companies: companiesFound,
      regions: regionsFound,
      investments,
      dealTypes: dealTypesFound,
      keySentences,
      impactScore
    };
  }

  return { loadData, analyze, extractCompanies, extractRegions, extractInvestments, extractDealTypes, extractKeySentences };
})();
