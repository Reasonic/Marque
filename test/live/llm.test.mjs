/**
 * Live provider smoke tests (TASKS.md 1.2).
 *
 * Unlike test/*.test.mjs, these call a REAL provider, so they are:
 *   - key-gated: skipped unless ANTHROPIC_API_KEY or OPENAI_API_KEY is set, so a
 *     keyless run (and every fork PR) stays green;
 *   - not in the default `npm test` glob (test/*.test.mjs) — run via
 *     `npm run test:live`, which the CI provider job invokes when a key exists;
 *   - deliberately small: one inferStructure + one select + one answer (3 calls),
 *     on the committed tier3.pdf, so no fixture fetch is needed and cost is bounded.
 *
 * The full measured sweep lives in bench/live-measure.mjs, not here.
 *
 * Run: ANTHROPIC_API_KEY=... npm run test:live   (or: node --env-file=.env --test 'test/live/*.test.mjs')
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { index, query, createLLM } from '../../src/index.mjs';

const FIXTURE = 'test/fixtures/tier3.pdf'; // no outline, uniform typography → forces tier 3
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

// Build the adapter and run tier 3 once; both tests reuse the result so the
// suite is three calls total (inferStructure + select + answer).
const llm = hasKey ? createLLM() : null;
const indexed = hasKey ? await index(FIXTURE, { llm }) : null;

test('live: tier 3 inferStructure resolves the no-structure fixture', { skip: !hasKey }, () => {
  assert.equal(indexed.tier, 'llm', 'a live model supplied the structure');
  assert.ok(indexed.llm_calls > 0);
  assert.ok(indexed.stats.sections > 0, 'headings were recovered from the body text');
  assert.ok(indexed.stats.verification.verified > 0, 'recovered headings verify locally');
});

test('live: retrieval select + answer run against the provider', { skip: !hasKey }, async () => {
  const res = await query(indexed, 'How does lease-based invalidation bound staleness?', { llm });

  // The selection may land on the LLM's picks or fall back to BM25; either way
  // both calls must have been made and produced a usable, citable answer.
  assert.ok(['llm', 'bm25'].includes(res.selection_by));
  assert.equal(res.tokens.llm_calls, 2, 'one select call and one answer call');
  assert.ok(res.tokens.select_in > 0, 'a selection payload was sent');
  assert.ok(res.tokens.answer_in > 0, 'an answering payload was sent');
  assert.ok(typeof res.answer === 'string' && res.answer.trim().length > 0, 'a non-empty answer came back');
});
