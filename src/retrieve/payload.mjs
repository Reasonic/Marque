/**
 * Payload construction — the part that decides the token bill.
 *
 * Two rules, both measured in bench/:
 *   1. Never send the whole tree. Navigation needs titles, not summaries.
 *   2. Never send whole pages. Sections have character-exact spans; use them.
 */
import { encode } from 'gpt-tokenizer/model/gpt-4o';
import { words } from '../text.mjs';

// PDF text legitimately contains control-token lookalikes (the GPT-4 technical
// report contains "<|endofprompt|>"), which the tokenizer rejects by default.
export const countTokens = (s) => encode(s, { disallowedSpecial: new Set() }).length;

/** Depth-annotated flat view of the tree, in document order. */
export function flatten(tree, depth = 0, out = []) {
  for (const node of tree) {
    out.push({ node, depth });
    if (node.nodes) flatten(node.nodes, depth + 1, out);
  }
  return out;
}

/**
 * A node's own text, excluding its descendants. Indexing parents with their
 * full subtree would duplicate every child's content and let long parents
 * dominate BM25 scoring.
 */
export function ownText(doc, node) {
  return doc.fullText.slice(node.char_start, node.nodes ? node.own_end : node.char_end);
}

/** Full text of a node including everything beneath it. */
export function subtreeText(doc, node) {
  return doc.fullText.slice(node.char_start, node.char_end);
}

/**
 * Navigation payload: ids and titles only, to a shallow depth.
 * PageIndex's get_document_structure() sends every node with its summary; on a
 * 220-page report that is ~4,200 tokens before the model has done anything.
 */
export function compactTree(flat, { maxDepth = 1 } = {}) {
  return flat
    .filter((f) => f.depth <= maxDepth)
    .map((f) => ({ id: f.node.node_id, title: f.node.title, pages: f.node.start_index }));
}

/**
 * Extract the passages of `text` most relevant to the question, up to maxTokens
 * — so an oversized section contributes the paragraphs that answer the question,
 * not its cover page.
 *
 * The answer is usually a needle, so this favours precision:
 *   - each query term is weighted by rarity in *this* text (IDF), so a
 *     discriminating word ("expenditure") outvotes a common one ("amount");
 *   - adjacent query words are also matched as a phrase ("capital expenditure"),
 *     which is far rarer than either word and gets a large weight;
 *   - several small passages are taken by local density, not one big window, so
 *     a dense cluster of a generic word in boilerplate cannot swamp the needle.
 * Falls back to the head when no term appears.
 */
export function windowAround(text, question, maxTokens, passageTokens = 800) {
  const tokens = countTokens(text);
  if (tokens <= maxTokens) return text;
  const cpt = text.length / tokens; // chars per token, for this text
  const budgetChars = Math.floor(maxTokens * cpt);
  const passChars = Math.floor(passageTokens * cpt);
  const lower = text.toLowerCase();

  const terms = [...new Set(words(question))].filter((t) => t.length >= 3);
  const phrases = [];
  const qw = words(question);
  for (let i = 0; i < qw.length - 1; i++) if (qw[i].length >= 3 && qw[i + 1].length >= 3) phrases.push(`${qw[i]} ${qw[i + 1]}`);

  // Financial questions ask for a figure; a query term sitting next to a currency
  // amount is far likelier to be the answer than the same term in prose. Boost it.
  const quantitative = /\b(amount|how much|how many|total|ratio|rate|percent|revenue|income|cash|margin|number of|usd|million|billion)\b|[%$]/i.test(question);
  const nearFigure = (at) => quantitative && /[$]\s?[\d,]|\b\d[\d,]{2,}/.test(text.slice(Math.max(0, at - 20), at + 90));

  const hits = []; // { at, w }
  const collect = (needle, boost) => {
    const ps = [];
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) ps.push(i);
    if (!ps.length || ps.length > tokens / 20) return; // absent, or so common it is noise
    const w = boost * Math.log(1 + tokens / ps.length); // rarer → higher
    for (const p of ps) hits.push({ at: p, w: w * (nearFigure(p) ? 2.5 : 1) });
  };
  for (const t of terms) collect(t, 1);
  for (const p of phrases) collect(p, 3); // a matched phrase is strong evidence

  if (!hits.length) return text.slice(0, budgetChars); // nothing discriminating: head

  // Local relevance at each hit: summed weight within a passage-sized neighbourhood.
  const half = Math.floor(passChars / 2);
  const scored = hits
    .map(({ at }) => ({ at, s: hits.reduce((n, h) => n + (Math.abs(h.at - at) <= half ? h.w : 0), 0) }))
    .sort((a, b) => b.s - a.s);

  // Greedily take the best non-overlapping passages until the budget is spent.
  const chosen = [];
  let spent = 0;
  for (const { at } of scored) {
    const start = Math.max(0, at - Math.floor(passChars * 0.3));
    const end = Math.min(text.length, start + passChars);
    if (chosen.some((c) => start < c.end && end > c.start)) continue;
    if (chosen.length && spent + (end - start) > budgetChars) break; // do not overshoot the budget
    chosen.push({ start, end });
    spent += end - start;
    if (spent >= budgetChars) break;
  }
  chosen.sort((a, b) => a.start - b.start);
  return chosen.map((c) => (c.start > 0 ? '…' : '') + text.slice(c.start, c.end) + (c.end < text.length ? '…' : '')).join('\n…\n');
}

/**
 * Assemble retrieved sections into an answering context, in rank order, stopping
 * at the token budget. Each block carries its node id and page range so answers
 * stay citable. A section too large to include whole contributes the passage
 * where the question's terms cluster (windowAround), not its head — so a figure
 * deep inside a coarse section still reaches the answerer.
 *
 * Single-document by default: text comes from `doc.fullText`. For a corpus, where
 * each node belongs to a different document, pass `getText(node)` to resolve a
 * node's own text (and give nodes a `gid`/`doc` so the citation names the file);
 * `doc` is then unused and may be null.
 */
export function assembleContext(doc, nodes, { budget = 6000, query = '', getText } = {}) {
  const resolve = getText || ((n) => doc.fullText.slice(n.char_start, n.char_end));
  const blocks = [];
  let used = 0;
  let truncated = 0;

  for (const node of nodes) {
    const remaining = budget - used;
    if (remaining < 200) break;
    const loc = node.start_index != null ? ` (p${node.start_index}-${node.end_index})` : '';
    const id = node.gid || node.node_id;
    const label = node.doc ? `${node.doc} — ${node.title}` : node.title;
    const header = `[${id}] ${label}${loc}\n`;
    const full = resolve(node).replace(/\n{3,}/g, '\n\n').trim();

    let body = full;
    if (countTokens(header + full) > remaining) {
      body = windowAround(full, query, remaining - countTokens(header));
      truncated++;
    }
    const block = header + body;
    blocks.push(block);
    used += countTokens(block);
  }

  return { text: blocks.join('\n\n---\n\n'), tokens: used, truncated };
}
