/**
 * Live LLM-path measurement (TASKS.md 1.2).
 *
 * Runs every path the deterministic mocks cannot reach — adjudicate() and
 * inferStructure() (tier 3), and select + answer (retrieval) — against a real
 * provider, and prints measured token counts, latency and accuracy. This is
 * what moves the README's LLM-path numbers from *modelled* to *measured*.
 *
 *   node --env-file=.env bench/live-measure.mjs        # reads ANTHROPIC/OPENAI key
 *
 * It makes ~36 real (paid) calls. The token/latency figures depend on the model,
 * so the model id is printed with the results.
 */
import { index, query, createLLM } from '../src/index.mjs';

// Same labelled queries as bench/retrieval-eval.mjs (kept in step by hand).
const SUITE = {
  'attn.pdf': [
    ['How is multi-head attention computed and why use multiple heads?', 'Multi-Head Attention'],
    ['What positional encoding scheme is used?', 'Positional Encoding'],
    ['Which optimizer and learning rate schedule were used?', 'Optimizer'],
    ['What were the results on English constituency parsing?', 'English Constituency Parsing'],
    ['How does self-attention compare to recurrent layers in complexity?', 'Why Self-Attention'],
  ],
  'bert.pdf': [
    ['What ablation studies were run on the pre-training objectives?', 'Ablation Studies'],
    ['What related work preceded BERT?', 'Related Work'],
    ['What experiments and benchmarks were evaluated?', 'Experiments'],
  ],
  'gpt4.pdf': [
    ['What are the limitations of the model?', 'Limitations'],
    ['How was the exam benchmark methodology designed?', 'Exam Benchmark Methodology'],
    ['What risks were identified and how were they mitigated?', 'Risks'],
    ['How well does loss prediction scale?', 'Loss Prediction'],
  ],
  'boe.pdf': [
    ['How does the Bank manage its risks?', 'Risk management'],
    ['What is reported about environmental impact?', 'Environment'],
    ['What did the Remuneration Committee report?', 'Remuneration Committee'],
  ],
  'brk.pdf': [
    ['What are the principal risk factors for the business?', 'Risk Factors'],
    ['What does the company say about cybersecurity?', 'Cybersecurity'],
  ],
};

const timed = async (fn) => { const t0 = Date.now(); const r = await fn(); return [r, Date.now() - t0]; };
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const llm = createLLM();
console.log(`provider model: ${llm.model.modelId}\n`);

// --- Tier 3a — adjudicate the entries local verification could not confirm.
const bareBrk = await index('bench/fixtures/brk.pdf');
const [adj, adjMs] = await timed(() => index('bench/fixtures/brk.pdf', { llm }));
console.log('adjudicate  brk.pdf');
console.log(`  unverified before → after : ${bareBrk.stats.verification.unverified} → ${adj.stats.verification.unverified}`);
console.log(`  adjudicated               : ${adj.stats.adjudicated}`);
console.log(`  llm calls / input tokens  : ${adj.llm_calls} / ${adj.llm_tokens}`);
console.log(`  latency                   : ${adjMs} ms\n`);

// --- Tier 3b — infer structure for a document that declares none.
const [inf, infMs] = await timed(() => index('test/fixtures/tier3.pdf', { llm }));
console.log('inferStructure  tier3.pdf');
console.log(`  tier                      : ${inf.tier}`);
console.log(`  sections recovered        : ${inf.stats.sections}`);
console.log(`  verified                  : ${inf.stats.verification.verified}/${inf.stats.sections}`);
console.log(`  llm calls / input tokens  : ${inf.llm_calls} / ${inf.llm_tokens}`);
console.log(`  latency                   : ${infMs} ms\n`);

// --- Retrieval — LLM selection + answering across the 17 labelled queries.
console.log('retrieval  select + answer  (selection_by should be "llm")');
let top4 = 0; let cited = 0; let total = 0;
const selIn = []; const ansIn = []; const lat = []; const miss = [];
for (const [file, cases] of Object.entries(SUITE)) {
  const indexed = await index(`bench/fixtures/${file}`);
  for (const [question, expected] of cases) {
    const [res, ms] = await timed(() => query(indexed, question, { llm }));
    total++;
    selIn.push(res.tokens.select_in);
    ansIn.push(res.tokens.answer_in);
    lat.push(ms);
    const hit = res.sections.some((s) => s.title.toLowerCase().includes(expected.toLowerCase()));
    if (hit) top4++; else miss.push(`${file}: "${expected}" — got "${res.sections[0]?.title ?? 'nothing'}"`);
    const hasCite = /\[\d{4}\]/.test(res.answer || '');
    if (hasCite) cited++;
    console.log(`  ${hit ? '✓' : '✗'} ${file.padEnd(9)} by=${res.selection_by.padEnd(4)} `
      + `sel_in=${String(res.tokens.select_in).padStart(4)} ans_in=${String(res.tokens.answer_in).padStart(5)} `
      + `cite=${hasCite ? 'y' : 'n'} ${String(ms).padStart(5)}ms  ${expected}`);
  }
}

const totalIn = selIn.map((s, i) => s + ansIn[i]);
console.log(`\nretrieval summary  (${total} queries)`);
console.log(`  LLM top-4 accuracy        : ${top4}/${total}  (BM25-only baseline: 14/17)`);
console.log(`  answers citing a section  : ${cited}/${total}`);
console.log(`  median select input       : ${median(selIn)} tok`);
console.log(`  median answer input       : ${median(ansIn)} tok`);
console.log(`  median total input/query  : ${median(totalIn)} tok`);
console.log(`  median latency/query      : ${median(lat)} ms`);
console.log(`  total llm calls           : ${total * 2}  (1 select + 1 answer each)`);
if (miss.length) { console.log('  misses:'); miss.forEach((m) => console.log(`    ${m}`)); }
