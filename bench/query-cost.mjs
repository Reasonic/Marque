/**
 * Query-path token instrumentation.
 *
 * Measures the *payload* cost of answering one question, comparing PageIndex's
 * retrieval shape against a progressive-disclosure design. Payload size is
 * deterministic, so this needs no API key — the only modelled quantity is
 * summary length, which is swept.
 *
 * PageIndex behaviour is taken from its source:
 *   - retrieve.py get_document_structure() returns the whole tree, stripping
 *     only `text`; `summary` is kept and config.yaml defaults it to "yes".
 *   - retrieve.py get_page_content(pages="5-7") returns whole pages.
 *   - examples/agentic_vectorless_rag_demo.py drives this as an agent loop, so
 *     every prior tool result is re-sent on each subsequent turn.
 *   - config.yaml: max_page_num_each_node 10, max_token_num_each_node 20000.
 */
import { encode } from 'gpt-tokenizer/model/gpt-4o';
import { index } from '../src/index.mjs';
import { pageRangeText } from '../src/extract/pdf.mjs';

// Document text is counted as literal text: PDFs legitimately contain strings
// like "<|endofprompt|>" (the GPT-4 report does), which the tokenizer rejects
// by default.
const tok = (s) => encode(s, { disallowedSpecial: new Set() }).length;

const MAX_PAGES_PER_NODE = 10;
const MAX_TOKENS_PER_NODE = 20000;
const SUMMARY_TOKENS = [40, 80, 120]; // swept: PageIndex's summary prompt is unconstrained
const SECTIONS_RETRIEVED = 3;
const SYSTEM_AND_QUESTION = 400;

/**
 * PageIndex splits a node when it exceeds BOTH limits, then re-indexes it into
 * children. Child count is LLM-determined; ceil(pages/10) is a deliberate
 * under-estimate, which biases the comparison in PageIndex's favour.
 */
function buildPageIndexNodes(docu) {
  const nodes = [];
  for (const s of docu.sections) {
    const pages = Math.max(1, s.endPage - s.page + 1);
    const text = pageRangeText(docu, s.page, s.endPage);
    const tokens = tok(text);
    nodes.push({ title: s.title, pages });
    if (pages > MAX_PAGES_PER_NODE && tokens >= MAX_TOKENS_PER_NODE) {
      const children = Math.ceil(pages / MAX_PAGES_PER_NODE);
      for (let i = 0; i < children; i++) nodes.push({ title: `${s.title} (part ${i + 1})`, pages: MAX_PAGES_PER_NODE });
    }
  }
  return nodes;
}

/** Full tree as get_document_structure() serialises it, at a given summary length. */
function structurePayload(nodes, summaryTokens) {
  const filler = 'x '.repeat(summaryTokens);
  const json = JSON.stringify(
    nodes.map((n, i) => ({
      title: n.title,
      node_id: String(i).padStart(4, '0'),
      start_index: 1,
      end_index: 1,
      summary: filler,
    })),
  );
  // Swap modelled filler for its exact token count so the JSON scaffolding stays real.
  return tok(json) - tok(filler) * nodes.length + summaryTokens * nodes.length;
}

/** Compact navigation payload: titles + ids only, top two levels. */
function compactTreePayload(docu) {
  const shallow = docu.sections.filter((s) => s.depth <= 1);
  return tok(JSON.stringify(shallow.map((s, i) => ({ id: String(i).padStart(4, '0'), title: s.title }))));
}

function report(indexed) {
  // The benchmark reuses the indexer's own extraction and section spans, so the
  // two cannot drift apart.
  const docu = {
    ...indexed._doc,
    name: indexed.doc_name,
    numPages: indexed.page_count,
    sections: indexed.sections,
  };
  const nodes = buildPageIndexNodes(docu);

  // Cost both addressing schemes for EVERY section, so the retrieval win is
  // reported as a distribution rather than a cherry-picked target set. The
  // saving comes entirely from sections smaller than the pages containing them,
  // so picking large sections understates it and small ones overstate it.
  const perSection = docu.sections.map((s) => {
    const pageTok = tok(pageRangeText(docu, s.page, s.endPage));
    const sectTok = tok(docu.fullText.slice(s.charStart, s.charEnd));
    return { pageTok, sectTok, ratio: pageTok / Math.max(sectTok, 1) };
  });
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const medRatio = median(perSection.map((p) => p.ratio));

  // A typical query retrieves typical sections, so target the median-sized ones.
  const targets = [...docu.sections]
    .map((s, i) => ({ s, size: perSection[i].sectTok }))
    .sort((a, b) => a.size - b.size)
    .slice(Math.max(0, Math.floor(docu.sections.length / 2) - 1))
    .slice(0, SECTIONS_RETRIEVED)
    .map((t) => t.s);

  const idx = targets.map((t) => docu.sections.indexOf(t));
  const pageLevel = idx.reduce((a, i) => a + perSection[i].pageTok, 0);
  const sectionLevel = idx.reduce((a, i) => a + perSection[i].sectTok, 0);
  const exact = docu.sections.filter((s) => s.exact).length;

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${docu.name}  —  ${docu.numPages} pages, ${docu.sections.length} outline sections`);
  console.log(`${'='.repeat(72)}`);
  console.log(`PageIndex-equivalent nodes after splitting : ${nodes.length}`);
  console.log(`Headings located to an exact char offset   : ${exact}/${docu.sections.length}`);
  console.log(`Page-range vs char-exact, all sections     : median ${medRatio.toFixed(2)}x, `
    + `best ${Math.max(...perSection.map((p) => p.ratio)).toFixed(1)}x`);
  console.log(`Retrieval payload, ${SECTIONS_RETRIEVED} median-sized sections:`);
  console.log(`    page-range addressing (PageIndex)      : ${pageLevel.toLocaleString()} tok`);
  console.log(`    char-exact sections (ours)             : ${sectionLevel.toLocaleString()} tok`
    + `   (${(pageLevel / Math.max(sectionLevel, 1)).toFixed(2)}x less)`);

  console.log(`\n  summary   PageIndex agent loop      ours (2 calls)      reduction`);
  console.log(`   tokens    tree    total billed        total billed`);
  console.log(`  ${'-'.repeat(64)}`);

  const rows = [];
  for (const st of SUMMARY_TOKENS) {
    const tree = structurePayload(nodes, st);

    // Agent loop: context accumulates, so each turn re-bills everything before it.
    const turns = [SYSTEM_AND_QUESTION, 80 /* get_document */, tree];
    for (let i = 0; i < SECTIONS_RETRIEVED; i++) turns.push(pageLevel / SECTIONS_RETRIEVED);
    let cum = 0;
    let billed = 0;
    for (const t of turns) { cum += t; billed += cum; }

    // Two bounded calls, no accumulation.
    const ours = (SYSTEM_AND_QUESTION + compactTreePayload(docu)) + (SYSTEM_AND_QUESTION + sectionLevel);

    rows.push({ st, tree, billed, ours });
    console.log(
      `  ${String(st).padStart(7)}  ${String(Math.round(tree)).padStart(6)}  `
      + `${String(Math.round(billed)).padStart(14)}      ${String(Math.round(ours)).padStart(12)}`
      + `      ${(billed / ours).toFixed(1)}x`,
    );
  }
  return { doc: docu.name, pages: docu.numPages, nodes: nodes.length, rows, pageLevel, sectionLevel };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node bench/query-cost.mjs <pdf...>');
  process.exit(1);
}
const all = [];
for (const f of files) all.push(report(await index(f)));

console.log(`\n${'='.repeat(72)}\nSUMMARY (at ${SUMMARY_TOKENS[1]}-token summaries)\n${'='.repeat(72)}`);
console.log('document              pages  nodes   PageIndex      ours   reduction');
for (const r of all) {
  const row = r.rows[1];
  console.log(
    `${r.doc.padEnd(20)} ${String(r.pages).padStart(6)} ${String(r.nodes).padStart(6)} `
    + `${String(Math.round(row.billed)).padStart(11)} ${String(Math.round(row.ours)).padStart(9)} `
    + `${(row.billed / row.ours).toFixed(1)}x`.padStart(11),
  );
}
