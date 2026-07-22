/**
 * Marque vs PageIndex on FinanceBench — same benchmark, PageIndex's number reused.
 *
 *   node --env-file=.env bench/financebench/pageindex-compare.mjs --budget 25
 *   node --env-file=.env bench/financebench/pageindex-compare.mjs --questions 30 --budget 8
 *
 * PageIndex / Mafin 2.5 report 98.7% on FinanceBench's 150-question public set.
 * Re-running their ~200-LLM-calls-per-document pipeline is expensive and beside
 * the point: their per-question answers are published
 * (VectifyAI/Mafin2.5-FinanceBench, result_gpt4o.json), so we *reuse* them and
 * only run Marque here. Both systems' answers are then graded by the identical
 * pair of judges, so the comparison is like-for-like:
 *
 *   1. PageIndex's OWN judge  (mafin-grade.mjs, their eval.py prompt, verbatim)
 *   2. our strict-agreement judge (grade.mjs), as a robustness check
 *
 * Both systems answer with the SAME model (gpt-4o — the base model behind
 * result_gpt4o.json), so the only variable is retrieval: Marque's structure-first
 * cross-document router vs PageIndex's LLM tree-navigation. Marque indexes every
 * filing at tier 1/2 with zero LLM calls; PageIndex rebuilds each tree with an LLM.
 *
 * Flags:
 *   --questions N    grade the first N questions (dataset order); omit for all 150
 *   --budget USD     hard ceiling; stops cleanly and reports partial results
 *   --answer-model   model Marque answers with (default gpt-4o, matches their file)
 *   --grader-model   judge for BOTH graders (default gpt-4o, their judge default)
 *   --resume         continue from an existing out file, skip graded questions
 *   --out FILE        results JSON (default bench/financebench/results-pageindex.json)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLM } from '../../src/index.mjs';
import { loadQuestions } from './load.mjs';
import { loadCorpus, prepare, route } from './router.mjs';
import { mafinGrade } from './mafin-grade.mjs';
import { grade as strictGrade } from './grade.mjs';
import { setBudget, record, spent, summary, guard } from '../meter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const MAFIN_URL = 'https://raw.githubusercontent.com/VectifyAI/Mafin2.5-FinanceBench/main/result_gpt4o.json';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
};
const N = Number(arg('questions', 0)) || 0;
const BUDGET = Number(arg('budget', 25));
const ANSWER_MODEL = arg('answer-model', 'gpt-4o');
const GRADER_MODEL = arg('grader-model', 'gpt-4o');
const OUT = arg('out', path.join(HERE, 'results-pageindex.json'));
const RESUME = process.argv.includes('--resume');

/** PageIndex's published per-question answers, fetched once and cached (gitignored). */
async function loadMafin() {
  const dest = path.join(DATA, 'mafin_result_gpt4o.json');
  if (!fs.existsSync(dest)) {
    const res = await fetch(MAFIN_URL);
    if (!res.ok) throw new Error(`fetch mafin results → ${res.status}`);
    await fsp.mkdir(DATA, { recursive: true });
    await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }
  const rows = JSON.parse(fs.readFileSync(dest, 'utf8'));
  return new Map(rows.map((r) => [r.question.trim(), r.mafin_answer]));
}

setBudget(BUDGET);
const providerOf = (id) => (/claude/i.test(id) ? 'anthropic' : 'openai');
const llm = createLLM({
  provider: providerOf(ANSWER_MODEL),
  model: ANSWER_MODEL,
  onUsage: ({ model, usage }) => record(model, usage),
});

const all = await loadQuestions();
const mafin = await loadMafin();
const questions = N ? all.slice(0, N) : all;
const docNames = [...new Set(all.map((q) => q.doc_name))]; // full library, always (single-database setting)

console.log(`Marque vs PageIndex on FinanceBench`);
console.log(`  grading ${questions.length} questions · library of ${docNames.length} filings`);
console.log(`  answerer ${ANSWER_MODEL} (both) · judges: PageIndex's own + our strict (${GRADER_MODEL}) · budget $${BUDGET}\n`);

// Index the whole library once — tier 1/2, no LLM, $0. Cached so resumes are instant.
const corpus = await loadCorpus(docNames, { cacheFile: path.join(DATA, 'router-cache.json'), log: (m) => console.log(m) });
const prepared = prepare(corpus);
console.log(`corpus tiers: ${JSON.stringify(corpus.tiers)}  (Marque indexing: ${corpus.units.length} units, 0 LLM calls, $0)\n`);

// Resume: seed from a prior out file, refusing to mix a different answerer/grader.
const results = [];
const done = new Set();
let priorCost = 0;
if (RESUME && fs.existsSync(OUT)) {
  const prior = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const pm = prior.models || {};
  if ((pm.answer && pm.answer !== ANSWER_MODEL) || (pm.grader && pm.grader !== GRADER_MODEL)) {
    throw new Error(`--resume: ${OUT} used a different model config (${JSON.stringify(pm)}). Move it aside or drop --resume.`);
  }
  for (const r of prior.results || []) { results.push(r); done.add(r.id); }
  priorCost = prior.cost_usd || 0;
  console.log(`resuming: ${results.length} already graded ($${priorCost} spent previously)\n`);
}

const rate = (rs, sys, judge) => {
  const v = rs.filter((r) => r[sys]?.[judge] && typeof r[sys][judge].correct === 'boolean');
  return v.length ? v.filter((r) => r[sys][judge].correct).length / v.length : null;
};
const buildReport = () => {
  const types = [...new Set(results.map((r) => r.type))];
  const routed = results.filter((r) => r.routed_to != null);
  return {
    benchmark: 'FinanceBench (150-question public subset)',
    models: { answer: ANSWER_MODEL, grader: GRADER_MODEL },
    pageindex_source: 'VectifyAI/Mafin2.5-FinanceBench/result_gpt4o.json (reused, not re-run)',
    pageindex_published_headline: '98.7% (their hybrid 3-judge OR: gpt-4o + o1-mini + o3-mini)',
    graded: results.length,
    cost_usd: Number((priorCost + spent()).toFixed(4)),
    marque_indexing_llm_calls: 0,
    routing_accuracy: routed.length ? routed.filter((r) => r.routed_to === r.doc).length / routed.length : null,
    doc_routing_recall: results.length ? results.filter((r) => r.doc_in_candidates).length / results.length : null,
    accuracy: {
      marque: { mafin_judge: rate(results, 'marque', 'mafin'), strict_judge: rate(results, 'marque', 'strict') },
      pageindex: { mafin_judge: rate(results, 'pageindex', 'mafin'), strict_judge: rate(results, 'pageindex', 'strict') },
    },
    by_type: Object.fromEntries(types.map((t) => {
      const rs = results.filter((r) => r.type === t);
      return [t, { n: rs.length, marque_mafin: rate(rs, 'marque', 'mafin'), pageindex_mafin: rate(rs, 'pageindex', 'mafin') }];
    })),
    results,
  };
};
const save = () => fs.writeFileSync(OUT, JSON.stringify(buildReport(), null, 2));

let stopped = null;
for (const q of questions) {
  if (done.has(q.financebench_id)) continue;
  try {
    guard();
    const r = await route(corpus, prepared, q.question, { llm });
    const marqueAns = r.answer ?? '';
    const piAns = mafin.get(q.question.trim()) ?? null; // reused PageIndex answer

    // Grade both systems with both judges (skip PageIndex if its answer is missing).
    const [mM, mS] = await Promise.all([
      mafinGrade(q.question, q.answer, marqueAns, { graderModel: GRADER_MODEL }),
      strictGrade(q.question, q.answer, marqueAns, { graderModel: GRADER_MODEL }),
    ]);
    let pi = null;
    if (piAns != null) {
      const [pM, pS] = await Promise.all([
        mafinGrade(q.question, q.answer, piAns, { graderModel: GRADER_MODEL }),
        strictGrade(q.question, q.answer, piAns, { graderModel: GRADER_MODEL }),
      ]);
      pi = { mafin: pM, strict: pS };
    }

    results.push({
      id: q.financebench_id, doc: q.doc_name, type: q.question_type,
      question: q.question, gold: q.answer,
      routed_to: r.chosen[0]?.doc ?? null,
      doc_in_candidates: r.routed_docs.includes(q.doc_name),
      marque: { answer: marqueAns, mafin: mM, strict: mS },
      pageindex: pi,
    });
    console.log(`  ${mM.correct ? '✓' : '✗'}marque ${pi ? (pi.mafin.correct ? '✓pi' : '✗pi') : '·pi'}  `
      + `route=${r.routed_to === q.doc_name ? 'hit' : (r.chosen[0]?.doc || 'none')}  `
      + `$${spent().toFixed(2)}  ${q.question.slice(0, 52)}`);
    save();
  } catch (e) {
    save();
    if (e.code === 'BUDGET_EXCEEDED') { stopped = e.message; break; }
    if (/credit balance|billing|authentication_error|invalid.*api.?key|permission|quota/i.test(e.message)) {
      stopped = `provider unavailable: ${e.message}`; break;
    }
    console.log(`  ! ${q.financebench_id}: ${e.message}`);
  }
}

// --- Report -----------------------------------------------------------------
const pct = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const report = buildReport();
save();

// Agreement grid under PageIndex's own judge (their terms).
const both = results.filter((r) => r.marque.mafin.correct && r.pageindex?.mafin.correct).length;
const mOnly = results.filter((r) => r.marque.mafin.correct && r.pageindex && !r.pageindex.mafin.correct).length;
const pOnly = results.filter((r) => !r.marque.mafin.correct && r.pageindex?.mafin.correct).length;
const neither = results.filter((r) => !r.marque.mafin.correct && r.pageindex && !r.pageindex.mafin.correct).length;

console.log(`\n${'='.repeat(66)}`);
if (stopped) console.log(`STOPPED: ${stopped}\n`);
console.log(`accuracy over ${results.length} graded questions (answerer ${ANSWER_MODEL}):\n`);
console.log(`                         PageIndex's judge     our strict judge`);
console.log(`  Marque (structure-1st)  ${pct(report.accuracy.marque.mafin_judge).padStart(8)}             ${pct(report.accuracy.marque.strict_judge).padStart(8)}`);
console.log(`  PageIndex (reused)      ${pct(report.accuracy.pageindex.mafin_judge).padStart(8)}             ${pct(report.accuracy.pageindex.strict_judge).padStart(8)}`);
console.log(`  PageIndex published     98.7% (their hybrid 3-judge OR)\n`);
console.log(`agreement under their judge: both ${both} · Marque-only ${mOnly} · PageIndex-only ${pOnly} · neither ${neither}`);
console.log(`routing: gold filing in stage-1 candidates ${pct(report.doc_routing_recall)} · picked as top section ${pct(report.routing_accuracy)}`);
console.log(`Marque indexing: 0 LLM calls, $0   ·   run cost: $${report.cost_usd}   (results → ${OUT})`);
console.log('\n--- meter ---\n' + summary());
