/**
 * segment-utils.js
 * pdf.jsのネイティブテキスト抽出結果、Google Vision OCR結果の両方を
 * 共通の segment = {text, height, x, y} 形式に変換し、
 * 「見出し文字は本文より大きい」というヒューリスティックで記事単位にグルーピングする。
 *
 * 注意: 新聞の多段組みレイアウトの完全な復元は困難なため、これはベストエフォートの近似。
 * 実運用では記事の切れ目がずれることがある前提で、一覧・詳細画面から確認する運用を想定。
 */

const SegmentUtils = (() => {

  function median(nums) {
    if (nums.length === 0) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // ---------- Vision OCR結果 → segments ----------

  function breakToChar(detectedBreak) {
    if (!detectedBreak) return "";
    switch (detectedBreak.type) {
      case "SPACE":
      case "SURE_SPACE":
        return " ";
      case "EOL_SURE_SPACE":
      case "LINE_BREAK":
        return "\n";
      default:
        return "";
    }
  }

  function visionBlockText(block) {
    let text = "";
    for (const para of block.paragraphs || []) {
      for (const word of para.words || []) {
        for (const sym of word.symbols || []) {
          text += sym.text;
          text += breakToChar(sym.property && sym.property.detectedBreak);
        }
      }
      text += "\n";
    }
    return text.trim();
  }

  function visionBlockAvgHeight(block) {
    const heights = [];
    for (const para of block.paragraphs || []) {
      for (const word of para.words || []) {
        for (const sym of word.symbols || []) {
          const v = sym.boundingBox && sym.boundingBox.vertices;
          if (!v || v.length < 4) continue;
          const ys = v.map(p => p.y || 0);
          const h = Math.max(...ys) - Math.min(...ys);
          if (h > 0) heights.push(h);
        }
      }
    }
    return heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : 0;
  }

  function visionBlockTopLeft(block) {
    const v = block.boundingBox && block.boundingBox.vertices;
    if (!v || v.length === 0) return { x: 0, y: 0 };
    return {
      x: Math.min(...v.map(p => p.x || 0)),
      y: Math.min(...v.map(p => p.y || 0))
    };
  }

  function segmentsFromVisionPage(visionPage) {
    if (!visionPage || !visionPage.blocks) return [];
    return visionPage.blocks
      .map(b => {
        const pos = visionBlockTopLeft(b);
        return {
          text: visionBlockText(b),
          height: visionBlockAvgHeight(b),
          x: pos.x,
          y: pos.y
        };
      })
      .filter(s => s.text.length > 0);
  }

  // ---------- pdf.js ネイティブテキスト抽出結果 → segments ----------

  /**
   * pdf.js の getTextContent() の items を行単位にまとめて segments を作る。
   * items[].transform = [a, b, c, d, e, f]  (e,f が原点位置、a,dがスケール≒フォントサイズ)
   */
  function segmentsFromTextContent(textContent, viewport) {
    const items = (textContent.items || [])
      .filter(it => it.str && it.str.trim().length > 0)
      .map(it => {
        const fontHeight = Math.hypot(it.transform[0], it.transform[1]) || 1;
        return {
          text: it.str,
          x: it.transform[4],
          y: it.transform[5],
          height: fontHeight
        };
      });

    if (items.length === 0) return [];

    // y降順(PDF座標系は下が0のため、上にあるものほどyが大きい) → 読み順に近似
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    // 疑似太字などで同一文字がほぼ同じ位置に重ねて描画されるケースを除去
    // (例: 「きょう」を同座標に2回描画して太く見せる手法)。
    // 直前アイテムとテキスト・x・yがほぼ一致するものは重複とみなしスキップする。
    const deduped = [];
    for (const it of items) {
      const prev = deduped[deduped.length - 1];
      const isOverlapDuplicate =
        prev &&
        prev.text === it.text &&
        Math.abs(prev.x - it.x) < 0.5 &&
        Math.abs(prev.y - it.y) < 0.5;
      if (!isOverlapDuplicate) deduped.push(it);
    }
    items.length = 0;
    items.push(...deduped);

    // 同じ行とみなす許容誤差(平均フォント高さの半分程度)
    const avgHeight = median(items.map(i => i.height)) || 10;
    const lineTolerance = avgHeight * 0.5;

    const lines = [];
    let currentLine = null;

    for (const it of items) {
      if (currentLine && Math.abs(currentLine.y - it.y) <= lineTolerance) {
        currentLine.parts.push(it);
        currentLine.y = (currentLine.y + it.y) / 2;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = { y: it.y, x: it.x, parts: [it] };
      }
    }
    if (currentLine) lines.push(currentLine);

    return lines.map(line => {
      const sortedParts = [...line.parts].sort((a, b) => a.x - b.x);
      return {
        text: sortedParts.map(p => p.text).join(""),
        height: median(sortedParts.map(p => p.height)),
        x: Math.min(...sortedParts.map(p => p.x)),
        y: line.y
      };
    });
  }

  // ---------- segments → 記事候補 ----------

  /**
   * @param {Array<{text,height,x,y}>} segments  同一ページ内の全セグメント
   * @param {number} pageNumber
   * @param {number} headlineRatio  本文中央値の何倍以上を見出しとみなすか
   */
  function groupSegmentsIntoArticles(segments, pageNumber, headlineRatio = 1.35) {
    const valid = segments.filter(s => s.text && s.text.trim().length > 0 && s.height > 0);
    if (valid.length === 0) return [];

    const baseHeight = median(valid.map(s => s.height)) || 1;

    const articles = [];
    let current = null;

    for (const s of valid) {
      const isHeadline = s.height >= baseHeight * headlineRatio;

      if (isHeadline || !current) {
        if (current) articles.push(current);
        current = {
          headline: isHeadline ? s.text.replace(/\s+/g, " ").trim() : `(見出し不明) p.${pageNumber}`,
          bodyParts: isHeadline ? [] : [s.text],
          pageNumber
        };
      } else {
        current.bodyParts.push(s.text);
      }
    }
    if (current) articles.push(current);

    return articles.map(a => ({
      headline: a.headline.slice(0, 80),
      body: a.bodyParts.join("\n"),
      pageNumber: a.pageNumber
    })).filter(a => a.body.trim().length > 0 || a.headline.trim().length > 0);
  }

  return { segmentsFromVisionPage, segmentsFromTextContent, groupSegmentsIntoArticles, median };
})();
