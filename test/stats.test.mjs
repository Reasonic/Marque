/**
 * The statistics helpers back published p-values and confidence intervals, so
 * they are pinned against hand-computable reference values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilson, mcnemarExact } from '../bench/stats.mjs';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test('wilson: 17/17 is a high interval capped at 1', () => {
  const [lo, hi] = wilson(17, 17);
  assert.ok(lo > 0.80 && lo < 0.83, `lo ${lo}`);
  assert.equal(hi, 1);
});

test('wilson: a half split centres near 0.5', () => {
  const [lo, hi] = wilson(50, 100);
  assert.ok(near((lo + hi) / 2, 0.5, 0.01));
  assert.ok(lo > 0.4 && hi < 0.6);
});

test('mcnemar: 10 vs 0 is 2·0.5^10', () => {
  assert.ok(near(mcnemarExact(10, 0).p, 2 * 0.5 ** 10));
});

test('mcnemar: no discordant pairs → p = 1', () => {
  assert.equal(mcnemarExact(0, 0).p, 1);
});

test('mcnemar: symmetric in its arguments', () => {
  assert.ok(near(mcnemarExact(22, 9).p, mcnemarExact(9, 22).p));
});

test('mcnemar: matches the reported FinanceBench verdicts', () => {
  assert.ok(mcnemarExact(24, 21).p > 0.7, 'ours vs RAPTOR is a clear tie');
  assert.ok(mcnemarExact(30, 19).p > 0.05, 'baseline vs ours does not reach significance');
  assert.ok(mcnemarExact(22, 9).p < 0.05, 'baseline vs RAPTOR is significant');
});
