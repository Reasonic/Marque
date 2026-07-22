/**
 * QASPER retrieval benchmark — structure-first vs. vectors on scientific prose.
 *
 *   node --env-file=.env bench/qasper/run.mjs            # full dev set
 *   node --env-file=.env bench/qasper/run.mjs --papers 20
 *
 * QASPER is the fair counterpart to FinanceBench: prose papers with clear section
 * structure, and — crucially — GOLD EVIDENCE paragraphs, so retrieval is scored
 * against ground truth with no LLM grader in the loop.
 *
 * Both systems rank the SAME units (the paper's sections/subsections); the only
 * variable is how. Marque ranks them by BM25 over the structure it read from the
 * document (zero LLM, zero embeddings). The baseline embeds each section with
 * text-embedding-3-small and ranks by cosine. A question's gold sections are the
 * ones containing its evidence paragraphs; we report recall@k and MRR.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { query } from '../../src/retrieve/query.mjs';
import { qasperDoc, evidenceSection } from './adapter.mjs';
import { wilson } from '../stats.mjs';
import { record, setBudget, spent, guard } from '../meter.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : d; };
const PAPERS = Number(arg('papers', 0)) || 0;
setBudget(Number(arg('budget', 8)));

const openai = createOpenAI();
const EMBED = 'text-embedding-3-small';
const KS = [1, 3, 5, 10];
const cosine = (a, b) => {
  let d = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

// QASPER dev set is fetched on demand (AllenAI, ~11 MB), never committed.
const DATA = new URL('./data/qasper-dev-v0.3.json', import.meta.url).pathname;
const DATADIR = new URL('./data/', import.meta.url).pathname;
if (!fs.existsSync(DATA)) {
  console.log('fetching QASPER dev set (AllenAI, ~11MB)…');
  fs.mkdirSync(DATADIR, { recursive: true });
  execSync(`curl -sL -o "${DATADIR}qasper.tgz" "https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz" `
    + `&& tar xzf "${DATADIR}qasper.tgz" -C "${DATADIR}" qasper-dev-v0.3.json`, { stdio: 'inherit' });
}
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const ids = (PAPERS ? Object.keys(data).slice(0, PAPERS) : Object.keys(data));

const hit = { marque: Object.fromEntries(KS.map((k) => [k, 0])), vector: Object.fromEntries(KS.map((k) => [k, 0])) };
let mrrM = 0; let mrrV = 0; let n = 0; let skipped = 0;

const firstHit = (ranks, gold) => { for (let r = 0; r < ranks.length; r++) if (gold.has(ranks[r])) return r; return -1; };

let done = 0;
for (const id of ids) {
  const paper = data[id];
  const indexed = qasperDoc(paper);
  const { sections } = indexed;
  if (sections.length < 2) continue;

  // Vector baseline indexes each section once (text capped ~8k tokens for the embedder).
  const secTexts = sections.map((s) => indexed._doc.fullText.slice(s.char_start, s.char_end).slice(0, 30000));
  guard();
  const secEmb = (await embedMany({ model: openai.embedding(EMBED), values: secTexts }));
  record(EMBED, { inputTokens: secEmb.usage?.tokens || 0 });

  // Embed all of this paper's questions in one call.
  const qs = paper.qas.filter((qa) => qa.answers.some((a) => (a.answer.evidence || []).length));
  if (!qs.length) continue;
  guard();
  const qEmb = (await embedMany({ model: openai.embedding(EMBED), values: qs.map((q) => q.question) }));
  record(EMBED, { inputTokens: qEmb.usage?.tokens || 0 });

  for (let qi = 0; qi < qs.length; qi++) {
    const qa = qs[qi];
    const gold = new Set();
    for (const a of qa.answers) for (const ev of (a.answer.evidence || [])) {
      const si = evidenceSection(sections, ev); if (si >= 0) gold.add(si);
    }
    if (!gold.size) { skipped++; continue; } // evidence was figures/tables only, or unmatched
    n++;

    // Marque: BM25 over the structure it read. No LLM, no embeddings.
    const res = await query(indexed, qa.question, { prefilter: 25 });
    const mRank = res.candidates.map((c) => Number(c.node_id)).filter((i) => !Number.isNaN(i));

    // Vector: cosine over the same section units.
    const vRank = secEmb.embeddings.map((e, i) => [i, cosine(qEmb.embeddings[qi], e)])
      .sort((a, b) => b[1] - a[1]).map(([i]) => i);

    const hm = firstHit(mRank, gold); const hv = firstHit(vRank, gold);
    for (const k of KS) { if (hm >= 0 && hm < k) hit.marque[k]++; if (hv >= 0 && hv < k) hit.vector[k]++; }
    if (hm >= 0) mrrM += 1 / (hm + 1);
    if (hv >= 0) mrrV += 1 / (hv + 1);
  }
  if (++done % 25 === 0) process.stdout.write(`  ${done}/${ids.length} papers, ${n} questions, $${spent().toFixed(3)}\n`);
}

// --- report ---------------------------------------------------------------
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const ci = (k) => { const [lo, hi] = wilson(k, n); return `[${pct(lo)}, ${pct(hi)}]`; };
console.log(`\n${'='.repeat(72)}`);
console.log('QASPER evidence-retrieval — structure-first (BM25) vs. vectors, same units');
console.log(`${n} questions with textual evidence over ${done} papers  (skipped ${skipped} figure/table-only)\n`);
console.log(`${'metric'.padEnd(14)} ${'Marque (no vec)'.padStart(22)} ${'vector baseline'.padStart(22)}`);
for (const k of KS) {
  console.log(`recall@${String(k).padEnd(7)} ${(`${pct(hit.marque[k] / n)}  ${ci(hit.marque[k])}`).padStart(22)} `
    + `${(`${pct(hit.vector[k] / n)}  ${ci(hit.vector[k])}`).padStart(22)}`);
}
console.log(`${'MRR'.padEnd(14)} ${pct(mrrM / n).padStart(22)} ${pct(mrrV / n).padStart(22)}`);
console.log(`\ncost: $${spent().toFixed(4)} (embeddings only; Marque side is $0)`);
