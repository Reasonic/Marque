/**
 * Tier 2 structure detection: infer headings from typography when a document
 * has no embedded outline. Zero LLM calls.
 *
 * Signals, in order of reliability:
 *   1. Section numbering ("3.1 Pre-training") — gives depth directly
 *   2. Font size above the document's body size
 *   3. Bold weight on a short line
 */

const NUMBERED = /^(\d+(?:\.\d+)*)\.?\s*(\S.*)$/;
const APPENDIX = /^(?:Appendix\s+)?([A-Z])(?:\.\d+)*\s+([A-Z]\S*.*)$/;
const KEYWORD = /^(abstract|introduction|conclusions?|references|bibliography|acknowledge?ments?|appendix|summary|discussion|methods?|results?|related work)\b/i;

const MAX_HEADING_CHARS = 90;
const SIZE_EPSILON = 0.4;

/** Body font size = the size carrying the most characters. */
function bodySize(lines) {
  const weight = new Map();
  for (const l of lines) weight.set(l.size, (weight.get(l.size) || 0) + l.text.length);
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked[0][0] : 0;
}

/**
 * Depth for headings that carry no numbering.
 *
 * Numbered headings are ground truth: if "2 Related Work" is 12pt, then every
 * other 12pt heading ("References", "Appendix") is also a top-level section.
 * Without that calibration, pure size-ranking makes the document title depth 0
 * and pushes real sections down a level, nesting References under Conclusion.
 */
function sizeDepths(candidates, body) {
  const observed = new Map();
  for (const c of candidates) {
    if (c.signal !== 'numbered') continue;
    if (!observed.has(c.size)) observed.set(c.size, []);
    observed.get(c.size).push(c.depth);
  }

  const map = new Map();
  for (const [size, depths] of observed) {
    const tally = new Map();
    for (const d of depths) tally.set(d, (tally.get(d) || 0) + 1);
    map.set(size, [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }

  // Sizes with no numbered evidence are ranked relative to the calibrated ones.
  const uncalibrated = [...new Set(candidates.map((c) => c.size))]
    .filter((s) => s > body + SIZE_EPSILON && !map.has(s))
    .sort((a, b) => b - a);
  for (const s of uncalibrated) {
    const larger = [...map.entries()].filter(([sz]) => sz > s).map(([, d]) => d);
    const smaller = [...map.entries()].filter(([sz]) => sz < s).map(([, d]) => d);
    if (larger.length) map.set(s, Math.min(Math.max(...larger) + 1, 3));
    else if (smaller.length) map.set(s, Math.max(Math.min(...smaller) - 1, 0));
    else map.set(s, 0);
  }
  return map;
}

export function detectHeadings(doc) {
  const lines = doc.lines;
  if (!lines.length) return [];
  const body = bodySize(lines);

  const candidates = [];
  for (const l of lines) {
    if (l.text.length > MAX_HEADING_CHARS || l.text.length < 2) continue;

    const num = NUMBERED.exec(l.text);
    const app = !num && APPENDIX.exec(l.text);
    const bigger = l.size > body + SIZE_EPSILON;
    const keyword = KEYWORD.test(l.text);

    // A numbered line only counts as a heading if it is also typographically
    // distinct — otherwise ordinary numbered list items are swept up.
    if (num && (bigger || l.bold)) {
      candidates.push({
        title: l.text,
        page: l.page,
        size: l.size,
        depth: num[1].split('.').length - 1,
        confidence: 'high',
        signal: 'numbered',
      });
    } else if (app && (bigger || l.bold)) {
      candidates.push({ title: l.text, page: l.page, size: l.size, depth: 0, confidence: 'high', signal: 'appendix' });
    } else if (bigger && l.page > 1) {
      // Front matter (title, authors, affiliations, emails) is typographically
      // large but is not document structure, so size alone is not trusted on
      // the first page — numbering and keywords still are.
      candidates.push({ title: l.text, page: l.page, size: l.size, depth: null, confidence: 'medium', signal: 'font-size' });
    } else if (keyword && (l.bold || bigger)) {
      candidates.push({ title: l.text, page: l.page, size: l.size, depth: 0, confidence: 'medium', signal: 'keyword' });
    }
  }

  const depths = sizeDepths(candidates, body);
  for (const c of candidates) {
    if (c.depth === null) c.depth = depths.get(c.size) ?? 0;
  }
  return candidates;
}

export { bodySize };
