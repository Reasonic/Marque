/**
 * Chunker unit tests for the benchmark baseline (TASKS.md 2.1).
 *
 * The network-dependent parts (contextualize/embed/answer) are covered by the
 * live FinanceBench run; what is tested here is the pure, deterministic chunking
 * — where the sharp bug lived: PDF-extracted filings arrive with no blank-line
 * paragraphs, and an unbounded chunk blew the embedding model's token limit.
 *
 * Run: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../bench/baseline.mjs';
import { countTokens } from '../src/retrieve/payload.mjs';

test('chunkText: bounds every chunk even when the text has no paragraph breaks', () => {
  // A long single line, like a filing whose PDF extraction joined every line.
  const text = Array.from({ length: 6000 }, (_, i) => `token${i}`).join(' ');
  const chunks = chunkText(text, { chunkTokens: 500, chunkOverlap: 50 });
  assert.ok(chunks.length > 1, 'a long single-line document is split');
  for (const c of chunks) {
    assert.ok(countTokens(c) <= 8192, 'no chunk exceeds the embedding per-input limit');
  }
});

test('chunkText: a short document is a single chunk', () => {
  assert.equal(chunkText('One short paragraph of text.', { chunkTokens: 500 }).length, 1);
});

test('chunkText: consecutive chunks overlap', () => {
  const paras = Array.from({ length: 30 }, (_, i) => `PARA_${i} ${'x '.repeat(40)}`).join('\n\n');
  const chunks = chunkText(paras, { chunkTokens: 200, chunkOverlap: 50 });
  assert.ok(chunks.length >= 2, 'splits into several chunks');

  const shares = chunks.slice(1).some((c, i) => {
    const prev = [...chunks[i].matchAll(/PARA_\d+/g)].map((m) => m[0]);
    const cur = new Set([...c.matchAll(/PARA_\d+/g)].map((m) => m[0]));
    return prev.some((p) => cur.has(p));
  });
  assert.ok(shares, 'consecutive chunks share at least one paragraph');
});
