/**
 * nikkei-index-parser.js
 *
 * 日経電子版の「印刷用ページ」形式に特有の構造を利用した記事分割。
 *
 * このPDFでは各記事の本文が並んだ後に、
 *   見出し(1〜3行)
 *   YYYY/MM/DD 日本経済新聞 朝刊 Nページ N文字 PDF有 書誌情報
 * という「書誌情報行」の並びが出てくる。この行にある文字数は
 * 見出しを含まない本文の文字数(改行を除く)と正確に一致するため、
 * これを使えば本文プールから記事ごとに文字数ぴったりで切り出せる。
 *
 * 見出しサイズによるヒューリスティック(segment-utils.js)よりも
 * このPDF形式では圧倒的に精度が高い。書誌情報行が見つからない
 * (＝紙面をそのままスキャン/撮影したようなPDFの)場合は null を返し、
 * 呼び出し側で従来のヒューリスティックにフォールバックする。
 */

const NikkeiIndexParser = (() => {
  // 見出しとしては扱わない、UI由来のノイズ行
  const JUNK_LINES = new Set([
    "キーワードを入力してください",
    "きょうの新聞",
    "きょうの新聞 きょうの新聞"
  ]);

  const META_REGEX =
    /(\d{4})\/(\d{2})\/(\d{2})\s*日本経済新聞\s*(?:朝刊|夕刊)?\s*(\d+)ページ\s*(\d+)文字[^\n]*/g;
  // 1行だけを対象に判定するための非グローバル版(lastIndex状態を共有しないよう分離)
  const META_LINE_REGEX =
    /^\d{4}\/\d{2}\/\d{2}\s*日本経済新聞\s*(?:朝刊|夕刊)?\s*\d+ページ\s*\d+文字/;

  function extractHeadline(text, matchStart) {
    const before = text.slice(Math.max(0, matchStart - 300), matchStart);
    const lines = before.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    const headlineLines = [];
    for (let i = lines.length - 1; i >= 0 && headlineLines.length < 3; i--) {
      const line = lines[i];
      if (JUNK_LINES.has(line)) break;
      // 前の記事の書誌情報行に行き当たったら、そこで見出し収集を止める
      if (META_LINE_REGEX.test(line)) break;
      headlineLines.unshift(line);
      // 句点で終わる行は前の記事の本文とみなし、そこで見出し収集を止める
      if (line.endsWith("。")) {
        headlineLines.shift(); // その行自体は見出しではないので除外
        break;
      }
    }
    return headlineLines.join("").slice(0, 80);
  }

  /**
   * @param {string} fullText  1ページ分の全文(改行込み)
   * @param {number} pageNumber
   * @returns {Array<{headline, body, pageNumber}>|null}
   */
  function parse(fullText, pageNumber) {
    if (!fullText) return null;

    const matches = [...fullText.matchAll(META_REGEX)];
    if (matches.length === 0) return null;

    const entries = matches.map(m => ({
      matchStart: m.index,
      matchEnd: m.index + m[0].length,
      charCount: parseInt(m[5], 10),
      headline: ""
    }));

    for (const e of entries) {
      e.headline = extractHeadline(fullText, e.matchStart) || `(見出し不明) p.${pageNumber}`;
    }

    // 見出し行+書誌情報行の範囲を除去して「本文プール」を作る。
    // 見出しの開始位置は、書誌情報行より前で headline の最後の行が
    // 現れる箇所から探す(簡易的に、書誌情報行の直前からheadline文字数ぶん
    // 遡った範囲を除去対象とする)。
    const removeRanges = entries.map(e => {
      // 見出し文字列の推定長より少し余裕を持って除去。
      // headlineは改行や行頭の空白を除去済みで元のテキストとほぼ同じ長さのため、
      // 過大な係数をかけると本文側の末尾まで誤って削ってしまう。
      const approxHeadlineSpan = Math.min(200, e.headline.length + 15);
      const start = Math.max(0, e.matchStart - approxHeadlineSpan);
      return { start, end: e.matchEnd };
    });

    // 除去範囲をマージしてから本文プールを構築
    removeRanges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const r of removeRanges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ ...r });
      }
    }

    let bodyPool = "";
    let cursor = 0;
    for (const r of merged) {
      bodyPool += fullText.slice(cursor, r.start);
      cursor = r.end;
    }
    bodyPool += fullText.slice(cursor);

    // 検索ボックスの文言などUI由来のノイズ行を本文プールからも除去
    bodyPool = bodyPool
      .split("\n")
      .filter(line => !JUNK_LINES.has(line.trim()))
      .join("\n");

    // 本文プールを先頭から文字数(改行除く)ぴったりで消費していく
    let poolIdx = 0;
    const articles = [];
    for (const e of entries) {
      let consumedNonNewline = 0;
      let sliceStart = poolIdx;
      while (poolIdx < bodyPool.length && consumedNonNewline < e.charCount) {
        if (bodyPool[poolIdx] !== "\n") consumedNonNewline++;
        poolIdx++;
      }
      const body = bodyPool.slice(sliceStart, poolIdx).trim();
      articles.push({
        headline: e.headline,
        body,
        pageNumber
      });
    }

    return articles;
  }

  return { parse };
})();
