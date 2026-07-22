/**
 * Run-to-run variance for the FinanceBench head-to-head. McNemar (significance.mjs)
 * captures sampling-over-questions uncertainty; this captures the *other* source —
 * LLM stochasticity from one full run to the next.
 *
 *   node bench/financebench/variance.mjs
 *
 * Reads every run file present and reports each system's per-run accuracy plus
 * mean, sample SD, and range. "ours" runs: results-expansion.json (#1) +
 * results-ours-run*.json. "RAPTOR" runs: results-raptor.json (#1) +
 * results-raptor-run*.json. Nothing is re-run here.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('.', import.meta.url).pathname;
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const files = fs.readdirSync(dir);

// accuracy = fraction correct, computed from the per-question records so the two
// harnesses (different result shapes) are scored identically.
const oursAcc = (d) => {
  const v = d.results.filter((r) => r.ours);
  return v.filter((r) => r.ours.correct).length / v.length;
};
const raptorAcc = (d) => d.results.filter((r) => r.correct).length / d.results.length;

const group = (match, acc) => files.filter(match).sort()
  .map((f) => ({ file: f, n: read(f).results.length, acc: acc(read(f)) }));

const ours = group((f) => f === 'results-expansion.json' || /^results-ours-run\d+\.json$/.test(f), oursAcc);
const raptor = group((f) => f === 'results-raptor.json' || /^results-raptor-run\d+\.json$/.test(f), raptorAcc);

const stats = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1
    ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;
  return { mean: m, sd, min: Math.min(...xs), max: Math.max(...xs) };
};

console.log(`${'='.repeat(64)}\nFinanceBench — run-to-run variance (LLM stochasticity)\n`);
for (const [name, runs] of [['ours (expansion)', ours], ['RAPTOR', raptor]]) {
  if (!runs.length) { console.log(`${name}: no run files found`); continue; }
  const accs = runs.map((r) => r.acc);
  const s = stats(accs);
  console.log(`${name}  (${runs.length} run${runs.length > 1 ? 's' : ''}):`);
  for (const r of runs) console.log(`  ${(100 * r.acc).toFixed(1)}%  (${Math.round(r.acc * r.n)}/${r.n})  ${r.file}`);
  console.log(`  → mean ${(100 * s.mean).toFixed(1)}%  SD ${(100 * s.sd).toFixed(1)} pts  `
    + `range [${(100 * s.min).toFixed(1)}%, ${(100 * s.max).toFixed(1)}%]\n`);
}
console.log('SD is the run-to-run spread of the point estimate; a small SD means the');
console.log('single-run headline is stable, not a lucky draw. With only ~3 runs the SD is');
console.log('itself approximate — read the range alongside it.');
