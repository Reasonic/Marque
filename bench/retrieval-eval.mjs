/**
 * Retrieval quality eval — labelled queries against known sections.
 *
 * Measures the BM25 prefilter, which is the ceiling on everything downstream:
 * if the right section is not in the shortlist, no amount of LLM selection or
 * answering can recover it. Runs with zero LLM calls.
 *
 * Ground truth is the section title a competent reader would open. Matching is
 * by title substring so the labels survive re-indexing.
 */
import { index } from '../src/index.mjs';
import { query } from '../src/retrieve/query.mjs';

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

const PREFILTER = 12;
const SELECT = 4;

let hits1 = 0; let hitsK = 0; let inShortlist = 0; let total = 0; let rr = 0;
const misses = [];

for (const [file, cases] of Object.entries(SUITE)) {
  const indexed = await index(`bench/fixtures/${file}`);
  console.log(`\n${file}  (${indexed.stats.sections} sections, tier=${indexed.tier})`);

  for (const [question, expected] of cases) {
    const res = await query(indexed, question, { prefilter: PREFILTER, select: SELECT });
    const match = (t) => t.toLowerCase().includes(expected.toLowerCase());

    const rankInShortlist = res.candidates.findIndex((c) => match(c.title));
    const rankInSelected = res.sections.findIndex((s) => match(s.title));

    total++;
    if (rankInShortlist !== -1) { inShortlist++; rr += 1 / (rankInShortlist + 1); }
    if (rankInSelected === 0) hits1++;
    if (rankInSelected !== -1) hitsK++; else misses.push({ file, question, expected, got: res.sections[0]?.title });

    const mark = rankInSelected === 0 ? '✓' : rankInSelected !== -1 ? '~' : '✗';
    console.log(`  ${mark} rank ${String(rankInShortlist === -1 ? '-' : rankInShortlist + 1).padStart(2)}  `
      + `${question.slice(0, 52).padEnd(54)} → ${expected}`);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`queries                    ${total}`);
console.log(`in shortlist (top ${PREFILTER})       ${inShortlist}/${total}  (${(100 * inShortlist / total).toFixed(0)}%)`);
console.log(`selected     (top ${SELECT})        ${hitsK}/${total}  (${(100 * hitsK / total).toFixed(0)}%)`);
console.log(`ranked first               ${hits1}/${total}  (${(100 * hits1 / total).toFixed(0)}%)`);
console.log(`MRR (over shortlist)       ${(rr / total).toFixed(3)}`);
if (misses.length) {
  console.log(`\nmisses:`);
  for (const m of misses) console.log(`  ${m.file}: "${m.expected}" — got "${m.got ?? 'nothing'}"`);
}
