/**
 * Reproduce every README benchmark table from a clean clone (TASKS.md 2.3).
 *
 *   npm run bench:all           # the free, deterministic tables (no API key)
 *
 * Splits into two: the tables anyone can reproduce with no key or spend, run
 * here directly; and the LLM-path tables, whose exact reproduction command and
 * rough cost are printed so a reader knows precisely how to regenerate them.
 * This keeps `bench:all` safe to run from a clean clone — it never spends money
 * on its own.
 */
import { execSync } from 'node:child_process';
import { index } from '../src/index.mjs';
import { MODELS, FINANCEBENCH_MODELS, FIXTURES } from './config.mjs';

const run = (cmd) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit' }); };

console.log('='.repeat(70));
console.log('Marque — reproducible benchmarks');
console.log('phase-1 models:   ', JSON.stringify(MODELS));
console.log('financebench models:', JSON.stringify(FINANCEBENCH_MODELS));
console.log('='.repeat(70));

// --- 1. Structure table (zero LLM calls, deterministic) --------------------
console.log('\n## Structure (zero LLM calls)\n');
console.log('doc       pages  tier      sections  exact   verified   ms');
for (const f of FIXTURES) {
  const r = await index(`bench/fixtures/${f}.pdf`);
  const v = r.stats.verification;
  console.log(`${f.padEnd(9)} ${String(r.page_count).padStart(4)}  ${r.tier.padEnd(8)}  `
    + `${String(r.stats.sections).padStart(6)}  ${r.stats.exact_offsets}/${r.stats.sections}  `
    + `${v.verified}/${v.partial}/${v.unverified}   ${r.elapsed_ms}`);
}

// --- 2. Retrieval eval + 3. query-cost (both zero-LLM) ---------------------
run('node bench/retrieval-eval.mjs');
run('node bench/query-cost.mjs bench/fixtures/*.pdf');

// --- LLM-path tables: reproduction commands only (they cost money) ---------
console.log(`\n${'='.repeat(70)}`);
console.log('LLM-path tables — need an API key; reproduce with:\n');
console.log('  # Measured tier-3 + retrieval (Opus 4.8; ~$1-2)');
console.log('  node --env-file=.env bench/live-measure.mjs\n');
console.log('  # FinanceBench head-to-head vs the tuned baseline (full 150 ≈ $95)');
console.log('  # answerer of record is claude-sonnet-5; use gpt-4o while Anthropic is unfunded:');
console.log('  node --env-file=.env bench/financebench/run.mjs --budget 150 --answer-model gpt-4o');
console.log('  # a cheaper slice:  --questions 30 --budget 25 --answer-model gpt-4o');
console.log(`${'='.repeat(70)}`);
