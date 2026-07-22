/**
 * RAPTOR head-to-head on FinanceBench — ours vs. RAPTOR (tree/summary RAG).
 *
 *   node --env-file=.env bench/financebench/raptor_run.mjs --budget 40
 *
 * RAPTOR (the real repo, via ./raptor_bridge.py) builds its recursive summary
 * tree per document and returns the retrieved context per question; here we
 * answer with the SAME gpt-4o and grade with the SAME grader as `ours` and the
 * vector baseline, so the only variable is retrieval. Its cost (OpenAI
 * embeddings + gpt-4o-mini summaries, run in Python) is metered from the bridge's
 * reported usage. RAPTOR builds are slow (~min/doc), so they run in a bounded
 * pool; answering/grading follows.
 *
 * ours/baseline numbers are read from their existing result files for the
 * comparison; only RAPTOR is run here.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { extract } from '../../src/extract/pdf.mjs';
import { answer as blAnswer } from '../baseline.mjs';
import { loadQuestions, ensurePdf, pickSubset } from './load.mjs';
import { grade } from './grade.mjs';
import { setBudget, record, spent, summary, guard } from '../meter.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : d; };
const N = Number(arg('questions', 0)) || 0;
const BUDGET = Number(arg('budget', 45));
const CONCURRENCY = Number(arg('concurrency', 5));
const OUT = new URL('./results-raptor.json', import.meta.url).pathname;
const PY = new URL('./raptor-venv/bin/python', import.meta.url).pathname;
const BRIDGE = new URL('./raptor_bridge.py', import.meta.url).pathname;
const MAX_CHARS = 900_000; // ~250k tokens, matching the baseline's doc cap

setBudget(BUDGET);

/** Run RAPTOR (index + retrieve) for one document via the Python bridge. */
function raptorDoc(text, questions) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [BRIDGE], { env: process.env });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* fall through */ }
      if (!parsed) return reject(new Error(`bridge exit ${code}: ${err.slice(-300)}`));
      if (parsed.error) return reject(new Error(parsed.error));
      resolve(parsed);
    });
    p.stdin.write(JSON.stringify({ text: text.slice(0, MAX_CHARS), questions }));
    p.stdin.end();
  });
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const all = await loadQuestions();
const { questions, docs } = pickSubset(all, N);
console.log(`RAPTOR head-to-head: ${questions.length} questions / ${docs.length} docs `
  + `(budget $${BUDGET}, ${CONCURRENCY} builds in parallel)\n`);

const byDoc = new Map();
for (const q of questions) (byDoc.get(q.doc_name) || byDoc.set(q.doc_name, []).get(q.doc_name)).push(q);
const docList = [...byDoc.entries()];

// --- 1. Build RAPTOR trees + retrieve, in parallel (the slow part) ----------
let built = 0;
const retrieved = await mapPool(docList, CONCURRENCY, async ([docName, qs]) => {
  try {
    const doc = await extract(await ensurePdf(docName));
    const r = await raptorDoc(doc.fullText, qs.map((q) => ({ id: q.financebench_id, question: q.question })));
    const u = r.usage || {};
    record('text-embedding-3-small', { inputTokens: u.embed_tokens || 0 });
    record('gpt-4o-mini', { inputTokens: u.sum_in || 0, outputTokens: u.sum_out || 0 });
    process.stdout.write(`  built ${docName} [${u.calls || 0} summaries, $${spent().toFixed(2)} total] (${++built}/${docList.length})\n`);
    return { docName, qs, contexts: r.contexts || {} };
  } catch (e) {
    process.stdout.write(`  ! ${docName}: ${e.message.slice(0, 120)}\n`);
    return { docName, qs, contexts: {}, failed: true };
  }
});

// --- 2. Answer (gpt-4o) + grade, same as ours/baseline ----------------------
console.log('\nanswering + grading…');
const results = [];
for (const { docName, qs, contexts } of retrieved) {
  await mapPool(qs, 6, async (q) => {
    try {
      guard();
      const ctx = contexts[q.financebench_id];
      let ans = '';
      if (ctx) ans = await blAnswer([{ chunk: ctx }], q.question, { answerModel: 'gpt-4o' });
      const v = await grade(q.question, q.answer, ans, { graderModel: 'gpt-4o' });
      results.push({ id: q.financebench_id, doc: docName, type: q.question_type, correct: v.correct });
    } catch (e) { process.stdout.write(`  ! grade ${q.financebench_id}: ${e.message.slice(0, 80)}\n`); }
  });
  fs.writeFileSync(OUT, JSON.stringify({ graded: results.length, cost_usd: Number(spent().toFixed(4)), results }, null, 2));
}

// --- 3. Report + compare to ours / baseline ---------------------------------
const rate = (rs) => (rs.length ? 100 * rs.filter((r) => r.correct).length / rs.length : 0);
const load = (f) => { try { return JSON.parse(fs.readFileSync(new URL(f, import.meta.url).pathname, 'utf8')); } catch { return null; } };
const oursF = load('./results-expansion.json');
const baseF = load('./results.json');
const oursRate = oursF ? 100 * oursF.results.filter((x) => x.ours.correct).length / oursF.graded : null;
const baseRate = baseF ? 100 * baseF.results.filter((x) => x.baseline?.correct).length / baseF.results.filter((x) => x.baseline).length : null;

console.log(`\n${'='.repeat(60)}`);
console.log(`RAPTOR:   ${results.filter((r) => r.correct).length}/${results.length}  ${rate(results).toFixed(1)}%`);
if (oursRate != null) console.log(`ours:     ${oursRate.toFixed(1)}%  (with query expansion)`);
if (baseRate != null) console.log(`baseline: ${baseRate.toFixed(1)}%  (vector, contextual)`);
console.log('\nRAPTOR by type:');
for (const t of [...new Set(results.map((r) => r.type))]) {
  const rs = results.filter((r) => r.type === t);
  console.log(`  ${t.padEnd(18)} n=${String(rs.length).padStart(3)}  ${rate(rs).toFixed(1)}%`);
}
console.log(`\ncost: $${spent().toFixed(4)}   (results → ${OUT})`);
console.log('\n--- meter ---\n' + summary());
