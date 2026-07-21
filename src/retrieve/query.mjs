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
import { flatten, compactTree, assembleContext, countTokens } from './payload.mjs';
import { retrievalUnits, snippet } from './units.mjs';
import { words } from '../text.mjs';

const DEFAULTS = {
  prefilter: 12,   // candidates BM25 hands to the selector
  select: 4,       // passages that reach the answering context
  budget: 6000,    // token ceiling for retrieved text
  navDepth: 1,     // tree depth exposed for navigation
};

const SELECT_PROMPT = `You are selecting which passages of a document can answer a question.
Return only the ids of passages likely to contain the answer, most relevant first.
Prefer few, precise passages. If none are relevant, return an empty list.`;

const ANSWER_PROMPT = `Answer the question using only the provided document sections.
Cite the section id in brackets for each claim, e.g. [0007].
If the sections do not contain the answer, say so plainly.`;

/**
 * @param {object} indexed  result of index()
 * @param {string} question
 * @param {object} [opts]
 * @param {object} [opts.llm] optional { expand?, select, answer } — see ../llm/
 */
export async function query(indexed, question, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const doc = indexed._doc;
  const flat = flatten(indexed.structure);
  const units = retrievalUnits(doc, flat);

  const accounting = { expand_in: 0, select_in: 0, select_out: 0, answer_in: 0, llm_calls: 0 };

  // --- 0. Optional query expansion. Lexical search cannot match "capex" to
  // "purchases of property, plant and equipment"; one cheap call adds the likely
  // synonyms and alternate phrasings the document may use instead of the user's
  // wording. A fixed extra call, never an agent loop; off when no expander is set.
  let searchQuery = question;
  if (cfg.llm?.expand) {
    accounting.llm_calls++;
    const extra = await cfg.llm.expand(question);
    if (extra) searchQuery = `${question} ${extra}`;
  }

  // --- 1. Local prefilter over retrieval units. No tokens spent, no index to sync.
  const corpus = units.map((u) => ({ title: u.title, text: doc.fullText.slice(u.char_start, u.char_end) }));
  const ranked = search(buildIndex(corpus), searchQuery, cfg.prefilter);
  const candidates = ranked.map((r) => ({ unit: units[r.doc], score: r.score }));

  /**
   * Drop any node whose span contains another selected node's span. A parent's
   * text already includes its children, so keeping both bills the same content
   * twice and crowds the budget. The more specific node wins.
   */
  const dropAncestors = (nodes) => nodes.filter((n) => !nodes.some((other) =>
    other !== n && other.char_start >= n.char_start && other.char_end <= n.char_end));

  // --- 2. Selection.
  let chosen = dropAncestors(candidates.map((c) => c.unit)).slice(0, cfg.select);
  let selectionBy = 'bm25';

  if (cfg.llm?.select) {
    const qTerms = new Set(words(searchQuery));
    const nav = compactTree(flat, { maxDepth: cfg.navDepth });
    // Each candidate carries a query-relevant snippet, so the selector judges on
    // evidence, not a section title alone (which is often generic — "Item 8.
    // Financial Statements" gives no hint that a capex figure lives inside).
    const shortlist = candidates.map((c) => ({
      id: c.unit.node_id,
      title: c.unit.title,
      snippet: snippet(doc.fullText.slice(c.unit.char_start, c.unit.char_end), qTerms),
    }));
    // Stable content first so it can sit in a cached prefix; question last.
    const payload = `${SELECT_PROMPT}\n\nDocument outline:\n${JSON.stringify(nav)}\n\n`
      + `Candidate passages:\n${JSON.stringify(shortlist)}\n\nQuestion: ${question}`;

    accounting.select_in = countTokens(payload);
    accounting.llm_calls++;
    const ids = await cfg.llm.select(payload, cfg.select);
    const byId = new Map(units.map((u) => [u.node_id, u]));
    const picked = (ids || []).map((id) => byId.get(id)).filter(Boolean);
    if (picked.length) { chosen = dropAncestors(picked).slice(0, cfg.select); selectionBy = 'llm'; }
  }

  // --- 3. Answer from a budgeted, citable context.
  const context = assembleContext(doc, chosen, { budget: cfg.budget, query: searchQuery });

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
      node_id: c.unit.node_id, title: c.unit.title, score: Math.round(c.score * 100) / 100,
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
