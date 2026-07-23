/**
 * Retrieval units and query-aware extraction — make a coarse structure usable
 * without embeddings or chunking-for-vectors.
 *
 * Two failures dominate on documents with a weak or missing outline (a 160-page
 * 10-K can collapse to one 112k-token "section"):
 *   1. Coverage — a broken outline can index only a fraction of the pages, so the
 *      rest is unreachable. `retrievalUnits` adds the sections *plus* a unit for
 *      any span the structure never claimed.
 *   2. Localisation — the answer budget keeps only a section's *head*, so a figure
 *      a hundred pages deep is never seen. `windowAround` instead extracts the
 *      passage where the question's own terms cluster.
 *
 * Recall stays at section granularity (well-structured documents are unchanged,
 * and the shortlist is not flooded by many windows of one big section); the
 * localisation happens only when an oversized section reaches the answer.
 */
import { countTokens } from './payload.mjs';

// A section larger than this is too coarse to *localize* a short answer inside —
// the section ranks, but the needle is one paragraph of many. We add finer
// sub-units over its span so retrieval can land on the paragraph, not the chapter.
const MAX_UNIT_TOKENS = 400;
const SUB_TOKENS = 220;
const SUB_OVERLAP = 60;

/**
 * Overlapping sub-window units over an oversized unit's span. The parent stays
 * (it carries the section title and gives coarse recall); a sub-unit that a query
 * selects supersedes it via query()'s ancestor-dropping. This is structure-first
 * with chunking *inside* a section too big to pinpoint — measured to lift clause
 * retrieval on contracts (CUAD) without a vector store, and it never changes a
 * unit's span, only adds finer ones.
 */
function subUnits(text, unit) {
  const total = countTokens(text.slice(unit.char_start, unit.char_end));
  if (total <= MAX_UNIT_TOKENS) return [];
  const span = unit.char_end - unit.char_start;
  const cpt = span / total; // chars per token, for this text
  const win = Math.round(SUB_TOKENS * cpt);
  const step = Math.max(1, Math.round((SUB_TOKENS - SUB_OVERLAP) * cpt));
  const out = [];
  for (let i = 0, k = 0; i < span; i += step, k += 1) {
    out.push({
      ...unit,
      node_id: `${unit.node_id}~${k}`,
      char_start: unit.char_start + i,
      char_end: Math.min(unit.char_end, unit.char_start + i + win),
    });
    if (unit.char_start + i + win >= unit.char_end) break;
  }
  return out;
}

/**
 * Sections as retrieval units, plus a unit for any text the structure leaves
 * uncovered, plus finer sub-units inside any section too large to localize a
 * short answer within (see subUnits). A well-sized section is untouched, so recall
 * on well-structured documents is unchanged; only oversized/collapsed spans gain
 * finer targets.
 * @param {object} [opts]
 * @param {boolean} [opts.subChunk=true] emit sub-units for oversized sections
 * @returns {Array<{node_id, title, char_start, char_end, start_index, end_index}>}
 */
export function retrievalUnits(doc, flat, opts = {}) {
  const { subChunk = true } = opts;
  const text = doc.fullText;
  const units = flat.map(({ node }) => ({
    node_id: node.node_id,
    title: node.title,
    // a node's own span, excluding descendants (they are their own units)
    char_start: node.char_start,
    char_end: node.nodes ? node.own_end : node.char_end,
    start_index: node.start_index,
    end_index: node.end_index,
  }));

  // Cover any span the structure never claimed. Merge node spans, fill the gaps.
  const spans = flat.map(({ node }) => [node.char_start, node.char_end]).sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  const gaps = [];
  for (const [s, e] of spans) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < text.length) gaps.push([cursor, text.length]);

  gaps.forEach(([gs, ge], g) => {
    if (countTokens(text.slice(gs, ge)) < 20) return; // ignore trivial whitespace gaps
    units.push({
      node_id: `_body${g}`,
      title: 'Document body',
      char_start: gs,
      char_end: ge,
      start_index: null,
      end_index: null,
    });
  });

  if (!subChunk) return units;
  return units.flatMap((u) => [u, ...subUnits(text, u)]);
}

/**
 * A short, query-relevant excerpt — evidence for the selector beyond the (often
 * generic) section title. Anchors on the first question term found.
 */
export function snippet(text, queryTerms, len = 180) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of queryTerms) {
    const i = lower.indexOf(w);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const from = at === -1 ? 0 : Math.max(0, at - 40);
  return text.slice(from, from + len).replace(/\s+/g, ' ').trim();
}
