/**
 * Statistical significance for the FinanceBench head-to-head — reads the existing
 * result files and reports, for free (no API calls):
 *
 *   1. each system's accuracy with a 95% Wilson confidence interval, so a point
 *      estimate is never quoted without its uncertainty, and
 *   2. a paired McNemar test for every pair, so "ours ties RAPTOR" and "the
 *      baseline is ahead" are backed by a p-value instead of eyeballing 51 vs 49.
 *
 *   node bench/financebench/significance.mjs
 *
 * "ours" is the query-expansion system (results-expansion.json); "baseline" is
 * the contextual vector RAG (results.json); "RAPTOR" is results-raptor.json.
 */
import fs from 'node:fs';
import { wilson, mcnemarExact, pct } from '../stats.mjs';

const load = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url).pathname, 'utf8'));
const ours = load('./results-expansion.json');
const base = load('./results.json');
const rapt = load('./results-raptor.json');

// id -> correct (boolean), one map per system
const M = {
  ours: new Map(ours.results.filter((r) => r.ours).map((r) => [r.id, !!r.ours.correct])),
  baseline: new Map(base.results.filter((r) => r.baseline).map((r) => [r.id, !!r.baseline.correct])),
  RAPTOR: new Map(rapt.results.map((r) => [r.id, !!r.correct])),
};

const ci = (map) => {
  const n = map.size; const k = [...map.values()].filter(Boolean).length;
  const [lo, hi] = wilson(k, n);
  return { k, n, acc: k / n, lo, hi };
};

console.log('='.repeat(72));
console.log('FinanceBench — accuracy with 95% CI, and paired significance (McNemar)\n');
console.log('Per-system strict agreement (95% Wilson CI):');
for (const [name, map] of Object.entries(M)) {
  const s = ci(map);
  console.log(`  ${name.padEnd(9)} ${String(s.k).padStart(3)}/${String(s.n).padStart(3)} = `
    + `${pct(s.acc).padStart(6)}   [${pct(s.lo)}, ${pct(s.hi)}]`);
}

// paired McNemar over the ids both systems graded
function pair(aName, bName) {
  const A = M[aName]; const B = M[bName];
  const ids = [...A.keys()].filter((id) => B.has(id));
  let b = 0; let c = 0; let both = 0; let neither = 0;
  for (const id of ids) {
    const a = A.get(id); const bb = B.get(id);
    if (a && !bb) b++; else if (!a && bb) c++; else if (a && bb) both++; else neither++;
  }
  const { p } = mcnemarExact(b, c);
  return { aName, bName, n: ids.length, b, c, both, neither, p };
}

console.log('\nPaired McNemar (two-sided exact binomial):');
console.log(`  ${'comparison'.padEnd(22)} ${'n'.padStart(3)}  ${'A>B'.padStart(4)} ${'B>A'.padStart(4)}  ${'p'.padStart(7)}   verdict`);
for (const [a, b] of [['baseline', 'ours'], ['ours', 'RAPTOR'], ['baseline', 'RAPTOR']]) {
  const r = pair(a, b);
  const sig = r.p < 0.05;
  const dir = r.b === r.c ? 'identical' : (r.b > r.c ? a : b) + ' ahead';
  const verdict = sig ? `SIGNIFICANT — ${dir}` : `not significant (parity; ${r.b} vs ${r.c} discordant)`;
  console.log(`  ${`${a} vs ${b}`.padEnd(22)} ${String(r.n).padStart(3)}  ${String(r.b).padStart(4)} ${String(r.c).padStart(4)}  ${r.p.toFixed(4)}   ${verdict}`);
}

console.log('\nA>B = A correct where B wrong; B>A = the reverse. McNemar tests only these');
console.log('discordant pairs. p < 0.05 ⇒ the difference is unlikely to be run-to-run noise.');
