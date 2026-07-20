/**
 * Payload construction — the part that decides the token bill.
 *
 * Two rules, both measured in bench/:
 *   1. Never send the whole tree. Navigation needs titles, not summaries.
 *   2. Never send whole pages. Sections have character-exact spans; use them.
 */
import { encode } from 'gpt-tokenizer/model/gpt-4o';

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
 * Assemble the retrieved sections into an answering context, newest-priority
 * first, stopping at the token budget. Each block carries its node id and page
 * range so answers stay citable.
 */
export function assembleContext(doc, nodes, { budget = 6000 } = {}) {
  const blocks = [];
  let used = 0;
  let truncated = 0;

  for (const node of nodes) {
    const body = subtreeText(doc, node).replace(/\n{3,}/g, '\n\n').trim();
    const header = `[${node.node_id}] ${node.title} (p${node.start_index}-${node.end_index})\n`;
    const cost = countTokens(header + body);

    if (used + cost > budget) {
      const remaining = budget - used;
      if (remaining < 200) { truncated++; continue; }
      // Keep the head of the section; it is where headings and topic sentences live.
      const ratio = remaining / cost;
      blocks.push(header + body.slice(0, Math.floor(body.length * ratio * 0.95)) + '\n…[truncated]');
      used = budget;
      truncated++;
      continue;
    }
    blocks.push(header + body);
    used += cost;
  }

  return { text: blocks.join('\n\n---\n\n'), tokens: used, truncated };
}
