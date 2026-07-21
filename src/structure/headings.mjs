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

// Back matter a tier-1 outline routinely omits. Detected on its own so a final
// outline section does not run to the end of the document (see detectTrailingMatter).
const TRAILING = /^(references|bibliography|appendix)\b/i;

// A heading that ends a sentence is complete; one that does not can be continued
// by the next line — i.e. it is one physical line of a multi-line title.
const TERMINAL = /[.!?]$/;

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

/**
 * Merge a heading that wrapped onto consecutive lines back into one entry.
 *
 * A wrapped title (BERT's appendix header is three lines) surfaces as several
 * candidates on adjacent lines at the same size and page, where each line but
 * the last does not end in terminal punctuation. Only a plain size-driven line
 * ('font-size') is absorbed — never a line carrying its own structural signal
 * (numbered/appendix/keyword) — so two distinct headings are never fused. The
 * `_y` guard (a continuation sits below its opener) rejects a same-page column
 * break, where the next line jumps back to the top of the next column.
 *
 * Candidates carry `_line` (index in doc.lines) and `_y`; both are extended to
 * the run's last line as it grows, and stripped by the caller.
 */
function mergeWrapped(candidates) {
  const out = [];
  for (const c of candidates) {
    const prev = out[out.length - 1];
    if (prev
      && c.signal === 'font-size'
      && c._line === prev._line + 1
      && c.page === prev.page
      && c.size === prev.size
      && c._y < prev._y
      && !TERMINAL.test(prev.title)) {
      prev.title = `${prev.title} ${c.title}`;
      prev._line = c._line;
      prev._y = c._y;
      continue;
    }
    out.push(c);
  }
  return out;
}

export function detectHeadings(doc) {
  const lines = doc.lines;
  if (!lines.length) return [];
  const body = bodySize(lines);

  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.text.length > MAX_HEADING_CHARS || l.text.length < 2) continue;

    const num = NUMBERED.exec(l.text);
    const app = !num && APPENDIX.exec(l.text);
    const bigger = l.size > body + SIZE_EPSILON;
    const keyword = KEYWORD.test(l.text);

    let c = null;
    // A numbered line only counts as a heading if it is also typographically
    // distinct — otherwise ordinary numbered list items are swept up.
    if (num && (bigger || l.bold)) {
      c = { title: l.text, page: l.page, size: l.size, depth: num[1].split('.').length - 1, confidence: 'high', signal: 'numbered' };
    } else if (app && (bigger || l.bold)) {
      c = { title: l.text, page: l.page, size: l.size, depth: 0, confidence: 'high', signal: 'appendix' };
    } else if (bigger && l.page > 1) {
      // Front matter (title, authors, affiliations, emails) is typographically
      // large but is not document structure, so size alone is not trusted on
      // the first page — numbering and keywords still are.
      c = { title: l.text, page: l.page, size: l.size, depth: null, confidence: 'medium', signal: 'font-size' };
    } else if (keyword && (l.bold || bigger)) {
      c = { title: l.text, page: l.page, size: l.size, depth: 0, confidence: 'medium', signal: 'keyword' };
    }
    if (c) { c._line = i; c._y = l.y; candidates.push(c); }
  }

  const merged = mergeWrapped(candidates);

  const depths = sizeDepths(merged, body);
  for (const c of merged) {
    if (c.depth === null) c.depth = depths.get(c.size) ?? 0;
    delete c._line;
    delete c._y;
  }
  return merged;
}

/**
 * Detect back matter (References / Bibliography / Appendix) that a tier-1
 * outline left out. Returns depth-0 boundary entries for any such heading at or
 * after the last structural entry that is not already present.
 *
 * Without this, a final outline section has no following entry, so locateSections
 * runs its span to the end of the document — Attention's "Conclusion" otherwise
 * swallows the references (p10-15). Zero LLM calls; reuses detectHeadings' signals.
 */
export function detectTrailingMatter(doc, entries) {
  const lines = doc.lines;
  if (!lines?.length || !entries.length) return [];
  const body = bodySize(lines);
  const lastPage = entries[entries.length - 1].page;
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const seen = new Set(entries.map((e) => key(e.title)));

  const found = [];
  for (const l of lines) {
    if (l.page < lastPage) continue;
    if (l.text.length < 2 || l.text.length > MAX_HEADING_CHARS) continue;
    if (!TRAILING.test(l.text)) continue;
    if (!(l.bold || l.size > body + SIZE_EPSILON)) continue;
    const k = key(l.text);
    if (seen.has(k)) continue;
    seen.add(k);
    found.push({ title: l.text, page: l.page, size: l.size, depth: 0, confidence: 'medium', signal: 'keyword' });
  }
  return found;
}

export { bodySize };
