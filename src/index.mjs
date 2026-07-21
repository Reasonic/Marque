/**
 * Marque — structure-first document indexing without a vector DB.
 *
 * Structure is recovered in tiers, cheapest first. Most real documents never
 * reach the LLM tier at all:
 *
 *   1. Embedded PDF outline  — exact, hierarchical, zero LLM calls
 *   2. Typography heuristics — font size + section numbering, zero LLM calls
 *   3. LLM inference         — only for what tiers 1-2 cannot resolve
 *
 * PageIndex starts at tier 3 unconditionally, spending ~200 LLM calls per
 * document to reconstruct information that tier 1 reads directly from the file.
 */
import { extract } from './extract/pdf.mjs';
import { detectHeadings, detectTrailingMatter } from './structure/headings.mjs';
import { verifyAll, UNVERIFIED } from './structure/verify.mjs';
import { adjudicate, inferStructure } from './structure/tier3.mjs';
import { locateSections, buildTree } from './structure/sections.mjs';

const MIN_OUTLINE_ENTRIES = 3;
const MIN_SECTIONS = 3;

const tallyOf = (entries) => entries.reduce((acc, e) => {
  acc[e.status] = (acc[e.status] || 0) + 1;
  return acc;
}, { verified: 0, partial: 0, unverified: 0 });

/**
 * @param {string} path
 * @param {object} [opts]
 * @param {object} [opts.llm] optional { json(prompt): Promise<object> } — enables tier 3
 */
export async function index(path, opts = {}) {
  const { minOutlineEntries = MIN_OUTLINE_ENTRIES, minSections = MIN_SECTIONS, llm } = opts;
  const started = Date.now();
  const doc = await extract(path);

  let entries;
  let tier;
  if (doc.outline.length >= minOutlineEntries) {
    entries = doc.outline;
    tier = 'outline';
  } else {
    entries = detectHeadings(doc);
    tier = 'headings';
  }

  let llmCalls = 0;
  let llmTokens = 0;

  // Tier 3a — the document declares no usable structure at all.
  if (entries.length < minSections && llm) {
    const inferred = await inferStructure(doc, llm);
    llmCalls += inferred.calls;
    llmTokens += inferred.tokens;
    if (inferred.entries.length) { entries = inferred.entries; tier = 'llm'; }
  }

  // Back matter (References / Bibliography / Appendix) is routinely missing from
  // a tier-1 outline. With no entry after it, the final section's span runs to
  // the end of the document and swallows the references. A typography pass adds
  // the missing boundary even when tier 1 supplied the structure.
  const trailing = detectTrailingMatter(doc, entries);
  if (trailing.length) entries = [...entries, ...trailing];

  let { entries: verified, tally, needsReview } = verifyAll(entries, doc.pages);

  // Tier 3b — adjudicate only what local verification could not confirm.
  if (needsReview.length && llm) {
    const adjudicated = await adjudicate(doc, verified, llm);
    llmCalls += adjudicated.calls;
    llmTokens += adjudicated.tokens;
    verified = adjudicated.entries;
    tally = tallyOf(verified);
    needsReview = verified.filter((e) => e.status === UNVERIFIED);
  }

  const located = locateSections(verified, doc.pages, doc.fullText.length);
  const tree = buildTree(located);

  return {
    doc_name: doc.name,
    page_count: doc.numPages,
    tier,
    llm_calls: llmCalls,
    llm_tokens: llmTokens,
    elapsed_ms: Date.now() - started,
    stats: {
      sections: located.length,
      exact_offsets: located.filter((e) => e.exact).length,
      verification: tally,
      adjudicated: located.filter((e) => e.adjudicated).length,
      // Entries tier 3 would adjudicate. Unverified means "could not confirm
      // locally", never "wrong" — the page number may well be correct.
      needs_review: needsReview.map((e) => e.title),
    },
    structure: tree,
    sections: located, // flat, document-ordered — used by the benchmarks
    _doc: doc,
  };
}

export { extract } from './extract/pdf.mjs';
export { sectionText } from './structure/sections.mjs';
export { query } from './retrieve/query.mjs';
export { createLLM } from './llm/index.mjs';
