/**
 * Retrieval: two bounded calls, never an agent loop.
 *
 * PageIndex drives retrieval as an agent that calls get_document_structure()
 * and get_page_content() in a loop. Because chat APIs resend the whole
 * conversation each turn, the tree and every fetched page are re-billed on
 * every subsequent turn — which bench/ measures as the single largest cost term.
 *
 * Here the pipeline is fixed:
 *   1. BM25 prefilter over sections        (local, 0 tokens)
 *   2. optional LLM selection from titles  (1 call, small payload)
 *   3. answer from the selected sections   (1 call, budgeted payload)
 *
 * Step 2 is optional. With no model configured the BM25 ranking is used
 * directly, giving a complete retrieval path with zero LLM calls.
 */
import { buildIndex, search } from './bm25.mjs';
import { flatten, ownText, compactTree, assembleContext, countTokens } from './payload.mjs';

const DEFAULTS = {
  prefilter: 12,   // candidates BM25 hands to the selector
  select: 4,       // sections that reach the answering context
  budget: 6000,    // token ceiling for retrieved text
  navDepth: 1,     // tree depth exposed for navigation
};

const SELECT_PROMPT = `You are selecting which sections of a document can answer a question.
Return only the ids of sections likely to contain the answer, most relevant first.
Prefer few, precise sections. If none are relevant, return an empty list.`;

const ANSWER_PROMPT = `Answer the question using only the provided document sections.
Cite the section id in brackets for each claim, e.g. [0007].
If the sections do not contain the answer, say so plainly.`;

/**
 * @param {object} indexed  result of index()
 * @param {string} question
 * @param {object} [opts]
 * @param {object} [opts.llm] optional { select, answer } — see ./llm.mjs
 */
export async function query(indexed, question, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const doc = indexed._doc;
  const flat = flatten(indexed.structure);

  // --- 1. Local prefilter. No tokens spent, no index to keep in sync.
  const corpus = flat.map((f) => ({ title: f.node.title, text: ownText(doc, f.node) }));
  const ranked = search(buildIndex(corpus), question, cfg.prefilter);
  const candidates = ranked.map((r) => ({ ...flat[r.doc], score: r.score }));

  const accounting = { select_in: 0, select_out: 0, answer_in: 0, llm_calls: 0 };

  /**
   * Drop any node whose span contains another selected node's span. A parent's
   * text already includes its children, so keeping both bills the same content
   * twice and crowds the budget. The more specific node wins.
   */
  const dropAncestors = (nodes) => nodes.filter((n) => !nodes.some((other) =>
    other !== n && other.char_start >= n.char_start && other.char_end <= n.char_end));

  // --- 2. Selection.
  let chosen = dropAncestors(candidates.map((c) => c.node)).slice(0, cfg.select);
  let selectionBy = 'bm25';

  if (cfg.llm?.select) {
    const nav = compactTree(flat, { maxDepth: cfg.navDepth });
    const shortlist = candidates.map((c) => ({ id: c.node.node_id, title: c.node.title, pages: c.node.start_index }));
    // Stable content first so it can sit in a cached prefix; question last.
    const payload = `${SELECT_PROMPT}\n\nDocument outline:\n${JSON.stringify(nav)}\n\n`
      + `Candidate sections:\n${JSON.stringify(shortlist)}\n\nQuestion: ${question}`;

    accounting.select_in = countTokens(payload);
    accounting.llm_calls++;
    const ids = await cfg.llm.select(payload, cfg.select);
    const byId = new Map(flat.map((f) => [f.node.node_id, f.node]));
    const picked = (ids || []).map((id) => byId.get(id)).filter(Boolean);
    if (picked.length) { chosen = dropAncestors(picked).slice(0, cfg.select); selectionBy = 'llm'; }
  }

  // --- 3. Answer from a budgeted, citable context.
  const context = assembleContext(doc, chosen, { budget: cfg.budget });

  let answer = null;
  if (cfg.llm?.answer) {
    const payload = `${ANSWER_PROMPT}\n\n${context.text}\n\nQuestion: ${question}`;
    accounting.answer_in = countTokens(payload);
    accounting.llm_calls++;
    answer = await cfg.llm.answer(payload);
  }

  return {
    question,
    answer,
    selection_by: selectionBy,
    sections: chosen.map((n) => ({
      node_id: n.node_id, title: n.title, pages: [n.start_index, n.end_index],
    })),
    candidates: candidates.map((c) => ({
      node_id: c.node.node_id, title: c.node.title, score: Math.round(c.score * 100) / 100,
    })),
    context: context.text,
    tokens: {
      ...accounting,
      context: context.tokens,
      truncated_sections: context.truncated,
      total_in: accounting.select_in + accounting.answer_in,
    },
  };
}
