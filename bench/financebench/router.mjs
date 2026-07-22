/**
 * Cross-document router — Marque retrieval in PageIndex's "single database" setting.
 *
 * PageIndex/Mafin 2.5 report their 98.7% with *all* FinanceBench filings in one
 * store, so retrieval must first find the right document and then the right
 * section. Marque indexes one document at a time; this router puts every filing's
 * structure into one BM25 space so the comparison is same-setting, not the easier
 * "here is the gold document" one.
 *
 * It reuses the library's own pieces unchanged — the tier-1/2 index (no LLM),
 * retrieval units with gap coverage, BM25, and the budgeted, query-aware context
 * assembler. The only addition is that the corpus spans documents. Retrieval stays
 * the same fixed two-call shape (select → answer, plus one optional expand); there
 * is no agent loop, exactly as the single-document path.
 */
import fs from 'node:fs';
import { index } from '../../src/index.mjs';
import { flatten, countTokens, windowAround } from '../../src/retrieve/payload.mjs';
import { retrievalUnits, snippet } from '../../src/retrieve/units.mjs';
import { buildIndex, search as bm25Search } from '../../src/retrieve/bm25.mjs';
import { words } from '../../src/text.mjs';
import { ensurePdf } from './load.mjs';

const SELECT_PROMPT = `You are selecting which passages, drawn from a library of financial filings, can answer a question.
Return the ids of every passage that could hold a figure the answer needs, most relevant first, all from the right filing (matching company and fiscal year).
A financial ratio or multi-figure question needs figures from SEVERAL statements — e.g. an "operating cash flow ratio" needs cash from operations (cash-flow statement) AND total current liabilities (balance sheet); a turnover ratio needs revenue (income statement) AND the asset (balance sheet). Select ALL the statements involved, not just one. If none are relevant, return an empty list.`;

const ANSWER_PROMPT = `Answer the question using only the provided document sections, which are drawn from SEC filings and include financial-statement tables.
Read figures carefully from the tables (mind units — thousands vs millions — and parentheses meaning negative). When the question asks for a ratio or a derived quantity and the component figures are present, compute it and show the numbers used. Give the final figure explicitly.
Cite the section id in brackets for each figure, e.g. [3M_2018_10K##0007].
If a needed figure is genuinely absent from the provided sections, say so plainly.`;

const companyOf = (docName) => docName.split('_')[0];

/**
 * A filing's identity label — company, fiscal year, form type — read from the
 * document (FinanceBench encodes it in the doc name, e.g. "3M_2018_10K"; the same
 * period sits on the filing's cover page). In the single-database setting this is
 * the routing signal: a question that says "FY2018 … 3M" must reach the 2018 3M
 * filing, not its 2022 one. Folded into each unit's title-boosted BM25 field so
 * company+year pull the right filing's sections into the shortlist. Without it,
 * lexical routing lands on the right company but the wrong year ~2/3 of the time.
 */
function docLabel(docName) {
  const parts = docName.split('_');
  const company = parts[0];
  const year = parts.find((p) => /^(19|20)\d{2}$/.test(p)) || '';
  const yi = parts.indexOf(year);
  const form = (yi !== -1 && parts[yi + 1]) || '';
  return `${company} ${year} ${form}`.replace(/\s+/g, ' ').trim();
}

/**
 * Index every filing at tier 1/2 (no LLM, $0) and flatten into one unit list.
 * The corpus is cached to disk (gitignored) so a resumed or repeated run does not
 * re-extract 84 PDFs. Cache holds each doc's fullText plus its units' char spans —
 * everything the searcher and the context assembler need, nothing more.
 *
 * @param {string[]} docNames
 * @param {object} [opts]
 * @param {string} [opts.cacheFile] path to a JSON cache (created if absent)
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{docs: Map<string, {fullText: string, company: string}>, units: Array, tiers: object}>}
 */
export async function loadCorpus(docNames, opts = {}) {
  const log = opts.log || (() => {});
  if (opts.cacheFile && fs.existsSync(opts.cacheFile)) {
    const raw = JSON.parse(fs.readFileSync(opts.cacheFile, 'utf8'));
    if (raw.docNames?.length === docNames.length && raw.docNames.every((d, i) => d === docNames[i])) {
      const docs = new Map(Object.entries(raw.docs));
      log(`corpus: loaded ${docs.size} filings from cache (${raw.units.length} units, 0 LLM, $0)`);
      return { docs, units: raw.units, tiers: raw.tiers };
    }
  }

  const docs = new Map();
  const units = [];
  const tiers = {};
  for (const docName of docNames) {
    const pdf = await ensurePdf(docName);
    const idx = await index(pdf); // no llm → tier 1/2 only, deterministic, $0
    tiers[idx.tier] = (tiers[idx.tier] || 0) + 1;
    const doc = idx._doc;
    const company = companyOf(docName);
    const label = docLabel(docName);
    docs.set(docName, { fullText: doc.fullText, company, label });
    for (const u of retrievalUnits(doc, flatten(idx.structure))) {
      units.push({
        gid: `${docName}##${u.node_id}`,
        docName,
        company,
        doc_label: label,
        node_id: u.node_id,
        title: u.title,
        char_start: u.char_start,
        char_end: u.char_end,
        start_index: u.start_index,
        end_index: u.end_index,
      });
    }
    log(`  ${docName}: tier=${idx.tier}, ${idx.sections.length} sections`);
  }

  if (opts.cacheFile) {
    fs.writeFileSync(opts.cacheFile, JSON.stringify({
      docNames, docs: Object.fromEntries(docs), units, tiers,
    }));
  }
  return { docs, units, tiers };
}

/**
 * Two searchers for the two stages of routing. Keeping them separate is the whole
 * fix: a single BM25 over every section conflates "which filing" with "which
 * section", and query expansion (generic cash-flow-statement vocabulary) then
 * matches every company's financials equally, so the selector routes to the wrong
 * company. Instead:
 *
 *   docSearch(query, k)          → the k filings whose identity best matches the
 *                                  question (company + fiscal year + cover page),
 *                                  scored *without* expansion so jargon can't blur
 *                                  one company into another.
 *   unitSearchIn(docSet, query)  → sections within only those filings, scored
 *                                  *with* expansion, where synonym bridging helps.
 */
const despace = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function prepare({ docs, units }) {
  const docNames = [...docs.keys()];

  // Stage 1 — filing routing. The question almost always names the company, and a
  // despaced substring match is exact and free: "Best Buy" → "bestbuy",
  // "Activision Blizzard" → "activisionblizzard", "3M" → "3m", all present in the
  // doc name's company token. Year then breaks ties between a company's filings.
  // A BM25 index over labels + cover pages is the fallback for the rare question
  // that names no company. This is far more reliable than lexical matching alone,
  // which drowns the company in identical SEC cover-page boilerplate.
  const meta = docNames.map((name) => ({ name, company: despace(companyOf(name)), year: docLabel(name).match(/\b(19|20)\d{2}\b/)?.[0] || '' }));
  const docCorpus = docNames.map((name) => {
    const d = docs.get(name);
    return { title: d.label, text: `${d.label} ${d.fullText.slice(0, 2500)}` };
  });
  const docIdx = buildIndex(docCorpus);

  // A few companies are named by an abbreviation the doc-name token does not
  // contain (the questions say "AMEX", "JnJ"). Expand those before matching.
  const ALIASES = { amex: 'americanexpress', jnj: 'johnson', jandj: 'johnson', jpm: 'jpmorgan' };

  /** Candidate filings for a question, most-likely first. `years` are pre-extracted. */
  const pickDocs = (question, years, k) => {
    let qn = despace(question);
    for (const [a, t] of Object.entries(ALIASES)) if (qn.includes(a)) qn += t;
    // Company matches (a company token appears in the despaced question). Guard the
    // shortest tokens (e.g. "3m", "aes") with a boundary check so they do not match
    // inside an unrelated word.
    const matched = meta.filter((m) => (m.company.length >= 4
      ? qn.includes(m.company)
      : new RegExp(`(^|[^a-z0-9])${m.company}([^a-z0-9]|$)`).test(question.toLowerCase())));
    if (matched.length) {
      // Keep *all* of the company's filings as candidates — some companies have a
      // 10-K, 10-Qs, 8-Ks and earnings releases, and the answer may be in any of
      // them, so capping at k drops the gold quarterly/earnings doc. The year the
      // question names orders them; stage-2 section search picks among them. Bounded
      // at 8 (no company here has more) so the section pool stays small.
      const yr = matched.filter((m) => years.includes(m.year));
      const ordered = [...yr, ...matched.filter((m) => !yr.includes(m))];
      return ordered.slice(0, Math.max(k, 8)).map((m) => m.name);
    }
    // Fallback: no company named — lexical routing over labels + cover pages.
    const q = years.length ? `${question} ${years.join(' ')}` : question;
    return bm25Search(docIdx, q, k).map((r) => docNames[r.doc]);
  };

  // Stage 2 — units grouped by filing, so a section search can be restricted to
  // the routed candidates. Small per-query BM25 (a few hundred units) is built on
  // demand; at this size it is a few milliseconds.
  const unitsByDoc = new Map();
  for (const u of units) (unitsByDoc.get(u.docName) || unitsByDoc.set(u.docName, []).get(u.docName)).push(u);
  const unitSearchIn = (docSet, query, k) => {
    const pool = docSet.flatMap((n) => unitsByDoc.get(n) || []);
    const corpus = pool.map((u) => ({
      title: `${u.doc_label} ${u.title}`,
      text: docs.get(u.docName).fullText.slice(u.char_start, u.char_end),
    }));
    return bm25Search(buildIndex(corpus), query, k).map((r) => pool[r.doc]);
  };

  return { pickDocs, unitSearchIn };
}

/** Drop any unit whose span contains another chosen unit's span *in the same doc*. */
const dropAncestors = (nodes) => nodes.filter((n) => !nodes.some((o) =>
  o !== n && o.docName === n.docName && o.char_start >= n.char_start && o.char_end <= n.char_end));

/**
 * Assemble chosen cross-document units into one budgeted, citable context. Mirrors
 * the library's single-doc assembler, but each block reads from its own filing's
 * text and its id is namespaced by document so citations stay unambiguous.
 */
function assembleContext(docs, chosen, { budget, query }) {
  const blocks = [];
  let used = 0;
  for (const n of chosen) {
    const remaining = budget - used;
    if (remaining < 200) break;
    const full = docs.get(n.docName).fullText.slice(n.char_start, n.char_end).replace(/\n{3,}/g, '\n\n').trim();
    const loc = n.start_index != null ? ` (p${n.start_index}-${n.end_index})` : '';
    const header = `[${n.gid}] ${n.company} — ${n.title}${loc}\n`;
    let body = full;
    if (countTokens(header + full) > remaining) body = windowAround(full, query, remaining - countTokens(header));
    const block = header + body;
    blocks.push(block);
    used += countTokens(block);
  }
  return { text: blocks.join('\n\n---\n\n'), tokens: used };
}

/**
 * Route one question across the whole library, in two stages:
 *   1. pick the candidate filings by identity (company + fiscal year), no expansion
 *   2. within only those filings: expand → BM25 → optional LLM select → answer
 * A fixed pipeline — one optional expand call, one optional select call, one
 * answer call. No agent loop.
 *
 * @returns {Promise<{answer: string|null, selection_by: string, routed_docs: string[], chosen: Array}>}
 */
export async function route(corpus, prepared, question, opts = {}) {
  // Financial questions frequently need figures from several statements at once
  // (balance sheet + income + cash flow), so stage-2 keeps more sections and a
  // larger context budget than the single-document default — otherwise a ratio's
  // second operand never reaches the answerer.
  const { llm, topDocs = 4, prefilter = 40, select = 8, budget = 9000 } = opts;
  const { docs } = corpus;

  // Fiscal-year routing signal. Questions write the year glued to a prefix
  // ("FY2018"), which the tokenizer keeps as one token ("fy2018") that never
  // matches a filing's bare "2018" label — so pull the bare year out explicitly.
  // Used only for stage-1 document routing, alongside the company name.
  const years = question.match(/(?:19|20)\d{2}/g) || [];
  const docQuery = years.length ? `${question} ${years.join(' ')}` : question;

  // Stage 1 — the filings this question is about, by company (+year). No expansion
  // here: generic financial vocabulary would match every company equally.
  const routedDocs = prepared.pickDocs(question, years, topDocs);

  // Stage 2 — sections within the routed filings, now with synonym expansion.
  let searchQuery = docQuery;
  if (llm?.expand) {
    const extra = await llm.expand(question);
    if (extra) searchQuery = `${searchQuery} ${extra}`;
  }
  const candidates = prepared.unitSearchIn(routedDocs, searchQuery, prefilter);
  let chosen = dropAncestors(candidates).slice(0, select);
  let selectionBy = 'bm25';

  if (llm?.select) {
    const qTerms = new Set(words(searchQuery));
    const shortlist = candidates.map((u) => ({
      id: u.gid,
      doc: u.doc_label,
      title: u.title,
      snippet: snippet(docs.get(u.docName).fullText.slice(u.char_start, u.char_end), qTerms),
    }));
    const payload = `${SELECT_PROMPT}\n\nCandidate passages:\n${JSON.stringify(shortlist)}\n\nQuestion: ${question}`;
    const ids = await llm.select(payload, select);
    const byId = new Map(candidates.map((u) => [u.gid, u]));
    const picked = (ids || []).map((id) => byId.get(id)).filter(Boolean);
    if (picked.length) { chosen = dropAncestors(picked).slice(0, select); selectionBy = 'llm'; }
  }

  const context = assembleContext(docs, chosen, { budget, query: searchQuery });
  let answer = null;
  if (llm?.answer) {
    answer = await llm.answer(`${ANSWER_PROMPT}\n\n${context.text}\n\nQuestion: ${question}`);
  }

  return {
    answer,
    selection_by: selectionBy,
    routed_docs: routedDocs,
    context: context.text,
    chosen: chosen.map((n) => ({ doc: n.docName, node_id: n.node_id, title: n.title, pages: [n.start_index, n.end_index] })),
  };
}
