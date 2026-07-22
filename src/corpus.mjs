/**
 * Multiple documents — routing across a corpus, without a vector store.
 *
 * The single-document path (index / query) answers "where in this file". A corpus
 * adds one question first: "which file". Marque already reads each document's
 * structure, so routing is the same idea one level up — rank documents by how well
 * the question matches their identity (name + section titles + a sample of body),
 * take the top few, then run the ordinary section retrieval within them.
 *
 * Two stages, both cheapest-tier-first, matching the library's invariants:
 *   1. route   — BM25 over per-document profiles picks candidate documents (0 LLM)
 *   2. within  — BM25 over those documents' sections → optional LLM select → answer
 * A fixed pipeline, never an agent loop; with no LLM configured it is a complete,
 * zero-token retrieval path, exactly like `query`.
 *
 * Known limit: near-duplicate documents that differ only by a detail the question
 * does not state — the same annual report for two fiscal years, say — are
 * inherently ambiguous to route by lexical match. State the distinguishing detail
 * in the question, or disambiguate upstream. (The FinanceBench benchmark in bench/
 * shows a domain-specific router that adds company + fiscal-year signals for
 * exactly that case; this library router stays general.)
 */
import { index } from './index.mjs';
import { flatten, countTokens, assembleContext } from './retrieve/payload.mjs';
import { retrievalUnits, snippet } from './retrieve/units.mjs';
import { buildIndex, search } from './retrieve/bm25.mjs';
import { words } from './text.mjs';

const DEFAULTS = {
  routeDepth: 4,   // candidate documents stage 1 hands to stage 2
  prefilter: 20,   // section candidates BM25 hands to the selector
  select: 5,       // sections that reach the answering context
  budget: 6000,    // token ceiling for retrieved text
};
const PROFILE_BODY = 1500; // chars of body folded into a document's routing profile

const SELECT_PROMPT = `You are selecting which passages, drawn from several documents, can answer a question.
Return only the ids of passages likely to contain the answer, most relevant first, all from the document the question is about. Prefer few, precise passages. If none are relevant, return an empty list.`;

const ANSWER_PROMPT = `Answer the question using only the provided document sections.
Cite the section id in brackets for each claim, e.g. [report.pdf##0007].
If the sections do not contain the answer, say so plainly.`;

/**
 * Index a set of documents into one routable corpus. Each document is indexed by
 * the ordinary tiered path (`index`), so the same cheapest-tier-wins rules and the
 * same `opts.llm` (for tier 3) apply per document.
 *
 * @param {string[]} paths  document paths (any supported format)
 * @param {object} [opts]   forwarded to index() per document (e.g. { llm })
 * @returns {Promise<object>} a corpus: { documents: Array<{doc_name, tier, llm_calls, sections, structure}>, ... }
 *   plus internal fields consumed by queryCorpus.
 */
export async function indexCorpus(paths, opts = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('indexCorpus: pass a non-empty array of document paths');
  }
  const docs = new Map();        // name -> { doc }
  const unitsByDoc = new Map();  // name -> units[] (each tagged with { doc, gid })
  const names = [];
  const profiles = [];           // { title, text } aligned with names, for the routing index
  const documents = [];          // public per-document summary

  for (const path of paths) {
    const idx = await index(path, opts);

    // Disambiguate a duplicate basename (two files named report.pdf) so citations
    // and routing stay unambiguous.
    let name = idx.doc_name;
    if (docs.has(name)) { let i = 2; while (docs.has(`${name}#${i}`)) i += 1; name = `${name}#${i}`; }

    const doc = idx._doc;
    const flat = flatten(idx.structure);
    docs.set(name, { doc });
    unitsByDoc.set(name, retrievalUnits(doc, flat).map((u) => ({ ...u, doc: name, gid: `${name}##${u.node_id}` })));
    names.push(name);
    // Routing profile: the document's identity. Its name and section titles carry
    // most of the signal; a slice of body catches documents whose titles are
    // generic. The name sits in the title-boosted field.
    const titles = flat.map((f) => f.node.title).join(' ');
    profiles.push({ title: name, text: `${name} ${titles} ${doc.fullText.slice(0, PROFILE_BODY)}` });
    documents.push({
      doc_name: name,
      tier: idx.tier,
      llm_calls: idx.llm_calls,
      sections: idx.sections.length,
      structure: idx.structure,
    });
  }

  return {
    documents,
    _docs: docs,
    _unitsByDoc: unitsByDoc,
    _names: names,
    _routeIndex: buildIndex(profiles),
  };
}

/** Drop any unit whose span contains another chosen unit's span *in the same document*. */
const dropAncestors = (nodes) => nodes.filter((n) => !nodes.some((o) =>
  o !== n && o.doc === n.doc && o.char_start >= n.char_start && o.char_end <= n.char_end));

/**
 * Answer a question over a corpus: route to the likely documents, then retrieve
 * and answer within them. Same two-call shape as `query` (one optional expand,
 * one optional select, one answer), plus the document-routing prefilter.
 *
 * @param {object} corpus  result of indexCorpus()
 * @param {string} question
 * @param {object} [opts]
 * @param {object} [opts.llm]        { expand?, select, answer } — see ../llm/
 * @param {number} [opts.routeDepth] candidate documents to search within (default 4)
 * @param {number} [opts.prefilter]  section candidates for the selector (default 20)
 * @param {number} [opts.select]     sections in the answering context (default 5)
 * @param {number} [opts.budget]     token ceiling for retrieved text (default 6000)
 */
export async function queryCorpus(corpus, question, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { _docs: docs, _unitsByDoc: unitsByDoc, _names: names, _routeIndex: routeIndex } = corpus;
  const textOf = (u) => docs.get(u.doc).doc.fullText.slice(u.char_start, u.char_end);
  const accounting = { expand_in: 0, select_in: 0, answer_in: 0, llm_calls: 0 };

  // --- 0. Optional query expansion (same rationale as query()): bridge a lexical
  // gap before both the document route and the section search.
  let searchQuery = question;
  if (cfg.llm?.expand) {
    accounting.llm_calls += 1;
    const extra = await cfg.llm.expand(question);
    if (extra) searchQuery = `${question} ${extra}`;
  }

  // --- 1. Route to candidate documents. Local, no tokens spent.
  const routed = search(routeIndex, searchQuery, cfg.routeDepth).map((r) => names[r.doc]);

  // --- 2. Section prefilter within only those documents. Small per-query index.
  const pool = routed.flatMap((n) => unitsByDoc.get(n) || []);
  const ranked = search(buildIndex(pool.map((u) => ({ title: `${u.doc} ${u.title}`, text: textOf(u) }))), searchQuery, cfg.prefilter);
  const candidates = ranked.map((r) => pool[r.doc]);

  // --- 3. Selection.
  let chosen = dropAncestors(candidates).slice(0, cfg.select);
  let selectionBy = 'bm25';
  if (cfg.llm?.select) {
    const qTerms = new Set(words(searchQuery));
    // Each candidate carries its document and a query-relevant snippet, so the
    // selector can pick the right file's section, not just a matching title.
    const shortlist = candidates.map((u) => ({ id: u.gid, doc: u.doc, title: u.title, snippet: snippet(textOf(u), qTerms) }));
    const payload = `${SELECT_PROMPT}\n\nCandidate passages:\n${JSON.stringify(shortlist)}\n\nQuestion: ${question}`;
    accounting.select_in = countTokens(payload);
    accounting.llm_calls += 1;
    const ids = await cfg.llm.select(payload, cfg.select);
    const byId = new Map(pool.map((u) => [u.gid, u]));
    const picked = (ids || []).map((id) => byId.get(id)).filter(Boolean);
    if (picked.length) { chosen = dropAncestors(picked).slice(0, cfg.select); selectionBy = 'llm'; }
  }

  // --- 4. Answer from a budgeted, citable context (per-node text resolver).
  const context = assembleContext(null, chosen, { budget: cfg.budget, query: searchQuery, getText: textOf });
  let answer = null;
  if (cfg.llm?.answer) {
    const payload = `${ANSWER_PROMPT}\n\n${context.text}\n\nQuestion: ${question}`;
    accounting.answer_in = countTokens(payload);
    accounting.llm_calls += 1;
    answer = await cfg.llm.answer(payload);
  }

  return {
    question,
    answer,
    selection_by: selectionBy,
    routed_documents: routed,
    sections: chosen.map((n) => ({ doc: n.doc, node_id: n.node_id, title: n.title, pages: [n.start_index, n.end_index] })),
    candidates: candidates.map((c) => ({ doc: c.doc, node_id: c.node_id, title: c.title })),
    context: context.text,
    tokens: { ...accounting, context: context.tokens, total_in: accounting.select_in + accounting.answer_in },
  };
}
