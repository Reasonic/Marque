/**
 * CUAD clause-retrieval — does reading a contract's structure beat blind chunking?
 *
 *   node bench/cuad/run.mjs              # all 510 contracts (0 LLM, $0)
 *   node bench/cuad/run.mjs --docs 60    # a quick slice
 *
 * CUAD is the counterpart to FinanceBench: FinanceBench is where structure-first
 * loses (figures in tables); contracts are where it should win (numbered clauses
 * with headings). The answers are highlighted clause spans, so retrieval is scored
 * directly against ground truth — no LLM grader.
 *
 * The metric is budget-normalised on purpose. Marque's plaintext structure
 * detection collapses on some contracts (a blob with no headings), and a naive
 * recall@k over "sections" would then be trivially 1 (one section = the whole
 * file). Instead we fix a reading budget B and ask: within B tokens of retrieved
 * text, did the gold clause make it in? Two methods, identical BM25 and identical
 * budget — the only difference is the segmentation:
 *
 *   Marque : BM25 over the clause structure Marque read (query()), windowed to B.
 *   chunks : BM25 over fixed-size overlapping chunks of the same text, to B.
 *
 * So the number isolates exactly what reading the structure buys. Both are $0.
 */
import fs from 'node:fs';
import { index } from '../../src/index.mjs';
import { query } from '../../src/retrieve/query.mjs';
import { buildIndex, search } from '../../src/retrieve/bm25.mjs';
import { countTokens, flatten } from '../../src/retrieve/payload.mjs';
import { retrievalUnits } from '../../src/retrieve/units.mjs';
import { wilson } from '../stats.mjs';
import { loadContracts } from './load.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : d; };
const DOCS = Number(arg('docs', 0)) || 0;
const BUDGET = Number(arg('budget', 1500));   // reading budget in tokens
const OUT = arg('out', new URL('./results.json', import.meta.url).pathname);

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Did the retrieved context surface a gold clause? We match the clause's leading
 * 60–200 normalised characters — enough to be specific (a coincidental 60-char
 * collision does not happen), short enough to survive the window's passage cuts.
 * Questions whose gold answer is shorter than 60 chars (a party name, a date) are
 * too low-specificity for a substring test and are scored separately.
 */
const isClause = (answers) => answers.some((a) => norm(a.text).length >= 60);
function surfaced(context, answers) {
  const c = norm(context);
  return answers.some((a) => {
    const g = norm(a.text);
    const L = Math.min(200, g.length);
    return L >= 60 && c.includes(g.slice(0, L));
  });
}

/** Fixed-size overlapping chunks, BM25-ranked, accumulated to the token budget. */
function chunkContext(text, q, budget) {
  const size = 1000; const overlap = 200;
  const chunks = [];
  for (let i = 0; i < text.length; i += size - overlap) { chunks.push(text.slice(i, i + size)); if (i + size >= text.length) break; }
  const ranked = search(buildIndex(chunks.map((t) => ({ title: '', text: t }))), q, 60);
  let ctx = ''; let used = 0;
  for (const r of ranked) {
    const t = chunks[r.doc];
    const tk = countTokens(t);
    if (used && used + tk > budget) break;
    ctx += `\n${t}`; used += tk;
    if (used >= budget) break;
  }
  return ctx;
}

const contracts = loadContracts();
const subset = DOCS ? contracts.slice(0, DOCS) : contracts;
console.log(`CUAD clause retrieval — Marque (structure) vs fixed chunks, budget ${BUDGET} tok, ${subset.length} contracts\n`);

const mk = () => ({ n: 0, marque: 0, chunk: 0 });
const tally = { all: mk(), structured: mk(), collapsed: mk() }; // clause questions only
const byCat = new Map(); // category -> { n, marque }
let collapsedDocs = 0; let units = 0; let done = 0; const tiers = {};

for (const c of subset) {
  const indexed = await index(c.txtPath);
  tiers[indexed.tier] = (tiers[indexed.tier] || 0) + 1;
  // Granularity is reported from the *base* structure (before sub-chunking), so
  // "collapsed" means the document genuinely declared little structure — sub-units
  // (which retrieval uses) would otherwise mask it.
  const nUnits = retrievalUnits(indexed._doc, flatten(indexed.structure), { subChunk: false }).length;
  units += nUnits;
  const isCollapsed = nUnits <= 2; if (isCollapsed) collapsedDocs += 1;
  const fullText = indexed._doc.fullText;

  for (const q of c.questions) {
    if (!isClause(q.answers)) continue; // short names/dates are too low-specificity to score by substring
    const mHit = surfaced((await query(indexed, q.query, { budget: BUDGET, prefilter: 30, select: 8 })).context, q.answers);
    const cHit = surfaced(chunkContext(fullText, q.query, BUDGET), q.answers);
    for (const b of ['all', isCollapsed ? 'collapsed' : 'structured']) {
      tally[b].n += 1; if (mHit) tally[b].marque += 1; if (cHit) tally[b].chunk += 1;
    }
    const cat = byCat.get(q.category) || { n: 0, marque: 0, chunk: 0 };
    cat.n += 1; if (mHit) cat.marque += 1; if (cHit) cat.chunk += 1; byCat.set(q.category, cat);
  }
  if (++done % 50 === 0) process.stdout.write(`  ${done}/${subset.length} contracts…\n`);
}

// --- report ----------------------------------------------------------------
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const ci = (k, n) => { const [lo, hi] = wilson(k, n); return `[${pct(lo)}, ${pct(hi)}]`; };
const row = (label, t) => `  ${label.padEnd(24)} Marque ${pct(t.marque / t.n).padStart(6)} ${ci(t.marque, t.n)}   `
  + `chunks ${pct(t.chunk / t.n).padStart(6)}   Δ ${(((t.marque - t.chunk) / t.n) * 100).toFixed(1)} pts   (n=${t.n})`;

console.log(`\n${'='.repeat(74)}`);
console.log(`CUAD clause-retrieval @ ${BUDGET} tokens — did the gold clause reach the context?`);
console.log('clause questions only (gold ≥ 60 chars); Marque structure-first vs fixed chunks, same BM25\n');
console.log(row('all contracts', tally.all));
console.log(row('  structured (>2 units)', tally.structured));
console.log(row('  collapsed (≤2 units)', tally.collapsed));

const cats = [...byCat.entries()].filter(([, v]) => v.n >= 15)
  .map(([k, v]) => [k, v.marque / v.n, v.chunk / v.n, v.n]).sort((a, b) => (b[1] - b[2]) - (a[1] - a[2]));
console.log('\nby category (n≥15), where structure helps most / least (Marque vs chunks):');
for (const [k, m, ch, n] of [...cats.slice(0, 5), ...cats.slice(-5)]) {
  console.log(`  Δ${(((m - ch) * 100)).toFixed(0).padStart(4)}  Marque ${pct(m).padStart(6)} chunks ${pct(ch).padStart(6)}  (${String(n).padStart(3)})  ${k}`);
}

console.log(`\nstructure Marque read: ${(units / subset.length).toFixed(1)} units/contract · `
  + `${pct(collapsedDocs / subset.length)} of contracts collapsed (≤2 units) · tiers ${JSON.stringify(tiers)}`);
console.log('indexing: 0 LLM calls, $0   ·   retrieval: BM25 only, $0');

fs.writeFileSync(OUT, JSON.stringify({
  budget: BUDGET, contracts: subset.length,
  clause_all: { n: tally.all.n, marque: tally.all.marque / tally.all.n, chunk: tally.all.chunk / tally.all.n },
  clause_structured: { n: tally.structured.n, marque: tally.structured.marque / tally.structured.n, chunk: tally.structured.chunk / tally.structured.n },
  clause_collapsed: { n: tally.collapsed.n, marque: tally.collapsed.marque / tally.collapsed.n, chunk: tally.collapsed.chunk / tally.collapsed.n },
  by_category: Object.fromEntries([...byCat].map(([k, v]) => [k, { n: v.n, marque: v.marque / v.n, chunk: v.chunk / v.n }])),
  structure: { units_per_contract: units / subset.length, collapsed_frac: collapsedDocs / subset.length, tiers },
}, null, 2));
console.log(`\nresults → ${OUT}`);
