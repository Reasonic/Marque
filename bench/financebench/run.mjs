/**
 * FinanceBench head-to-head: our structure-first retrieval vs. the tuned
 * contextual-embedding baseline, same answerer, same grader, same questions.
 *
 *   node --env-file=.env bench/financebench/run.mjs --questions 30 --budget 40
 *
 * Flags:
 *   --questions N   subset size (most-covered docs first); omit for all 150
 *   --budget USD    hard ceiling; the run stops and reports partial results
 *   --answer-model  model both systems answer with (default claude-opus-4-8)
 *   --out FILE      results JSON (default bench/financebench/results.json)
 *
 * Reports strict agreement per system and per question type, plus measured cost.
 * Documents are the cost driver (the baseline contextualizes every chunk), so
 * the subset is chosen most-covered-first; that bias is stated in the output.
 */
import fs from 'node:fs';
import { index, query, createLLM } from '../../src/index.mjs';
import { extract } from '../../src/extract/pdf.mjs';
import { buildIndex as blBuild, retrieve as blRetrieve, answer as blAnswer } from '../baseline.mjs';
import { loadQuestions, ensurePdf, pickSubset } from './load.mjs';
import { grade } from './grade.mjs';
import { setBudget, record, spent, summary, guard } from '../meter.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
};

const N = Number(arg('questions', 0)) || 0;
const BUDGET = Number(arg('budget', 45));
const ANSWER_MODEL = arg('answer-model', 'claude-opus-4-8');
const OUT = arg('out', new URL('./results.json', import.meta.url).pathname);

setBudget(BUDGET);
const llm = createLLM({ onUsage: ({ model, usage }) => record(model, usage) });

const all = await loadQuestions();
const { questions, docs } = pickSubset(all, N);
console.log(`FinanceBench: ${questions.length} questions across ${docs.length} docs `
  + `(budget $${BUDGET}, answerer ${ANSWER_MODEL})\n`);

// Group questions by document so each document is indexed once per system.
const byDoc = new Map();
for (const q of questions) (byDoc.get(q.doc_name) || byDoc.set(q.doc_name, []).get(q.doc_name)).push(q);

const results = [];
let stopped = null;

const rate = (rs, sys) => (rs.length ? rs.filter((r) => r[sys].correct).length / rs.length : 0);
const buildReport = () => {
  const types = [...new Set(results.map((r) => r.type))];
  return {
    model: ANSWER_MODEL,
    graded: results.length,
    stopped,
    cost_usd: Number(spent().toFixed(4)),
    strict_agreement: { ours: rate(results, 'ours'), baseline: rate(results, 'baseline') },
    by_type: Object.fromEntries(types.map((t) => {
      const rs = results.filter((r) => r.type === t);
      return [t, { n: rs.length, ours: rate(rs, 'ours'), baseline: rate(rs, 'baseline') }];
    })),
    results,
  };
};
// Write after every document so a long run survives a crash or a kill.
const save = () => fs.writeFileSync(OUT, JSON.stringify(buildReport(), null, 2));

outer:
for (const [docName, qs] of byDoc) {
  try {
    guard();
    process.stdout.write(`${docName} (${qs.length} q) … `);
    const pdf = await ensurePdf(docName);
    const doc = await extract(pdf);

    // Index once per system.
    const ours = await index(pdf, { llm });
    const bl = await blBuild(doc.fullText, { answerModel: ANSWER_MODEL });
    process.stdout.write(`indexed [ours tier=${ours.tier}, baseline ${bl.items.length} chunks, $${spent().toFixed(2)}]\n`);

    for (const q of qs) {
      guard();
      const oursRes = await query(ours, q.question, { llm });
      const oursAns = oursRes.answer ?? '';

      const blChunks = await blRetrieve(bl, q.question);
      const blAns = await blAnswer(blChunks, q.question, { answerModel: ANSWER_MODEL });

      const [oursV, blV] = await Promise.all([
        grade(q.question, q.answer, oursAns),
        grade(q.question, q.answer, blAns),
      ]);

      results.push({
        id: q.financebench_id, doc: docName, type: q.question_type,
        question: q.question, gold: q.answer,
        ours: { answer: oursAns, correct: oursV.correct, reason: oursV.reason },
        baseline: { answer: blAns, correct: blV.correct, reason: blV.reason },
      });
      console.log(`  ${oursV.correct ? '✓' : '✗'}ours ${blV.correct ? '✓' : '✗'}base  `
        + `$${spent().toFixed(2)}  ${q.question.slice(0, 60)}`);
    }
    save(); // checkpoint after each document
  } catch (e) {
    save();
    if (e.code === 'BUDGET_EXCEEDED') { stopped = e.message; break outer; }
    // Non-recoverable provider states (out of credit, bad key) — abort rather
    // than spin through every remaining document failing the same way.
    if (/credit balance|billing|authentication_error|invalid.*api.?key|permission/i.test(e.message)) {
      stopped = `provider unavailable: ${e.message}`;
      break outer;
    }
    console.log(`  ! ${docName}: ${e.message}`);
  }
}

// --- Aggregate -------------------------------------------------------------
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const report = buildReport();
save();

console.log(`\n${'='.repeat(64)}`);
if (stopped) console.log(`STOPPED: ${stopped}\n`);
console.log(`strict agreement over ${results.length} graded questions:`);
console.log(`  ours (structure-first)   ${pct(report.strict_agreement.ours)}`);
console.log(`  baseline (contextual)    ${pct(report.strict_agreement.baseline)}`);
console.log('\nby question type:');
for (const [t, v] of Object.entries(report.by_type)) {
  console.log(`  ${t.padEnd(18)} n=${String(v.n).padStart(3)}  ours ${pct(v.ours).padStart(6)}  baseline ${pct(v.baseline).padStart(6)}`);
}
console.log(`\ncost: $${report.cost_usd}   (results → ${OUT})`);
console.log('\n--- meter ---\n' + summary());
