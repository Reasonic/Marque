/**
 * Structure-extraction accuracy — self-supervised, deterministic, zero LLM, ~$0.
 *
 *   npm run bench:structure-accuracy
 *
 * The question this answers: when a document has NO embedded outline (the common
 * case — only ~1 in 5 of the 10-Ks here ships one), how faithfully does tier-2
 * typography recover the document's real structure?
 *
 * We answer it without hand-labelling anything. Every PDF that *does* ship an
 * embedded outline is its own ground truth: we take that outline as gold, then
 * run tier-2 typography (`detectHeadings`) as if the outline were absent and
 * score what it recovered. The outline is never shown to the detector — this is
 * exactly the no-outline path the detector takes in production, graded against a
 * truth the file itself provides.
 *
 * Because nothing here calls an LLM, the result is exact and reproducible: run it
 * twice, get the same numbers. No averaging, no variance.
 *
 * Honesty note on precision: an embedded outline routinely OMITS real headings
 * (unnumbered subsections, back matter). A typography hit that isn't in the
 * outline is therefore not necessarily wrong — so precision-vs-outline is a LOWER
 * BOUND on true precision, and recall is the cleaner "did we recover the declared
 * structure" metric. Both are reported; neither is inflated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extract } from '../src/extract/pdf.mjs';
import { detectHeadings } from '../src/structure/headings.mjs';

const MIN_GOLD = 5;        // a document needs a real outline to serve as gold
const PAGE_TOL = 1;        // outline destination vs. rendered heading line, in pages
const OVERLAP = 0.6;       // token-overlap coefficient for a title match

const DIRS = [
  new URL('./fixtures', import.meta.url).pathname,
  new URL('./financebench/pdfs', import.meta.url).pathname,
];

// --- title matching --------------------------------------------------------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (s) => new Set(norm(s).split(' ').filter(Boolean));

/**
 * Two titles match if they share most of their (shorter side's) tokens and at
 * least one shared token is substantial — so "1 Introduction" matches
 * "Introduction" but "Note 1" never matches "Note 2" (shared token is a digit,
 * and the overlap is only half).
 */
function titleMatch(a, b) {
  const A = toks(a); const B = toks(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  let substantial = false;
  for (const t of A) if (B.has(t)) { inter++; if (t.length >= 4) substantial = true; }
  return substantial && inter / Math.min(A.size, B.size) >= OVERLAP;
}

/**
 * Greedy match: each gold heading claims the nearest-page, unclaimed typography
 * heading whose title matches. Returns the matched-pair count.
 *
 * We score DETECTION only — did tier-2 find the heading? — not hierarchy depth.
 * Depth is deliberately excluded: every outline uses its own depth convention
 * (Verizon marks cover-page boilerplate depth-0; an academic paper marks its real
 * sections depth-0), so a flat pred-vs-gold depth comparison measures convention
 * mismatch, not detection. Recovering hierarchy without numbering is a separate,
 * weaker tier-2 capability, out of scope for a detection benchmark.
 */
function score(gold, pred) {
  const used = new Set();
  let matched = 0;
  for (const g of gold) {
    let best = -1; let bestD = Infinity;
    for (let i = 0; i < pred.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(pred[i].page - g.page);
      if (d > PAGE_TOL || d >= bestD) continue;
      if (!titleMatch(g.title, pred[i].title)) continue;
      best = i; bestD = d;
    }
    if (best >= 0) { used.add(best); matched++; }
  }
  return matched;
}

// --- corpus ----------------------------------------------------------------
const pdfs = DIRS.flatMap((d) => (fs.existsSync(d)
  ? fs.readdirSync(d).filter((f) => f.endsWith('.pdf')).map((f) => path.join(d, f)) : []));

if (!pdfs.length) {
  console.error('No PDFs found. Run `npm run fixtures` and the FinanceBench loader first.');
  process.exit(1);
}

const rows = [];
for (const p of pdfs) {
  let doc;
  try { doc = await extract(p); } catch { continue; }
  const gold = doc.outline.filter((e) => e.page != null && e.title);
  if (gold.length < MIN_GOLD) continue;                 // no usable gold → skip

  const pred = detectHeadings(doc);
  const matched = score(gold, pred);
  const recall = matched / gold.length;
  const precision = pred.length ? matched / pred.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  rows.push({
    name: doc.name.replace(/\.pdf$/, ''),
    pages: doc.numPages,
    gold: gold.length,
    pred: pred.length,
    matched,
    recall,
    precision,
    f1,
  });
  process.stdout.write(`  scored ${rows.length}: ${rows[rows.length - 1].name}\n`);
}

// --- report ----------------------------------------------------------------
const pct = (x) => (x == null ? '  -  ' : `${(100 * x).toFixed(1)}%`.padStart(6));
rows.sort((a, b) => b.gold - a.gold);

console.log(`\n${'='.repeat(92)}`);
console.log('Structure-extraction accuracy — tier-2 typography vs. the document\'s own embedded outline');
console.log('(outline hidden from the detector; deterministic, zero LLM)\n');
console.log(`${'document'.padEnd(26)} ${'pg'.padStart(4)} ${'gold'.padStart(5)} ${'pred'.padStart(5)} `
  + `${'recall'.padStart(6)} ${'prec*'.padStart(6)} ${'F1'.padStart(6)}`);
for (const r of rows) {
  const flag = r.recall < 0.2 ? '  ← no font-size signal (bold-only; needs tier-1/3)' : '';
  console.log(`${r.name.slice(0, 26).padEnd(26)} ${String(r.pages).padStart(4)} ${String(r.gold).padStart(5)} `
    + `${String(r.pred).padStart(5)} ${pct(r.recall)} ${pct(r.precision)} ${pct(r.f1)}${flag}`);
}

// micro = pooled over every heading; macro = mean over documents. Both, so the
// two Verizon filings (hundreds of headings each) can't quietly set the score.
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const microR = sum('matched') / sum('gold');
const microP = sum('matched') / sum('pred');
const microF1 = (2 * microP * microR) / (microP + microR);
const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;

console.log(`\n${'-'.repeat(92)}`);
console.log(`docs: ${rows.length}   gold headings: ${sum('gold')}   typography headings: ${sum('pred')}   matched: ${sum('matched')}`);
console.log(`\nMICRO (heading-weighted):  recall ${pct(microR)}   precision* ${pct(microP)}   F1 ${pct(microF1)}`);
console.log(`MACRO (document-weighted): recall ${pct(mean('recall'))}   precision* ${pct(mean('precision'))}   F1 ${pct(mean('f1'))}`);

// The failure is concentrated, not diffuse: split the corpus at "did tier-2 find
// a font-size signal at all?" so the bimodality is visible rather than averaged away.
const distinct = rows.filter((r) => r.recall >= 0.2);
const boldOnly = rows.filter((r) => r.recall < 0.2);
const microROf = (rs) => rs.reduce((a, r) => a + r.matched, 0) / rs.reduce((a, r) => a + r.gold, 0);
console.log(`\nfont-size-distinct docs (${distinct.length}/${rows.length}):  micro recall ${pct(microROf(distinct))}`);
console.log(`bold-at-body-size docs  (${boldOnly.length}/${rows.length}):  micro recall ${pct(microROf(boldOnly))}  `
  + `— headings carry no font-size cue; in production these ship a tier-1 outline`);
console.log('\n* precision vs. the outline is a LOWER BOUND: outlines omit real headings, so an');
console.log('  unmatched typography hit is not necessarily a false positive. Recall is exact.');

fs.writeFileSync(new URL('./structure-accuracy-results.json', import.meta.url).pathname,
  JSON.stringify({ min_gold: MIN_GOLD, page_tol: PAGE_TOL, overlap: OVERLAP, micro: { recall: microR, precision: microP, f1: microF1 }, docs: rows }, null, 2));
