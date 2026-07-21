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

/**
 * Sections as retrieval units, plus a unit for any text the structure leaves
 * uncovered. No windowing — a section stays whole, so recall behaves exactly as
 * before on documents whose outline is complete.
 * @returns {Array<{node_id, title, char_start, char_end, start_index, end_index}>}
 */
export function retrievalUnits(doc, flat) {
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

  return units;
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
