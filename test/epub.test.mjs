/**
 * EPUB extraction — an EPUB is a ZIP of XHTML chapters plus a package (OPF) giving
 * their reading order; the chapters' <h1>–<h6> are the outline, so it resolves at
 * tier 1 with no LLM. Reuses the ZIP reader (DOCX) and the HTML section parser.
 *
 * Fixture test/fixtures/sample.epub is a spec-shaped EPUB (mimetype, container,
 * OPF manifest+spine, two chapters) validated with the system `unzip`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { index, query } from '../src/index.mjs';

const FIXTURE = 'test/fixtures/sample.epub';

test('epub: chapters resolve at tier 1, fully verified, no LLM', async () => {
  const r = await index(FIXTURE);
  assert.equal(r.tier, 'outline');
  assert.equal(r.llm_calls, 0);
  assert.equal(r.stats.sections, 3, 'two chapters: Introduction, Approach > Prior Work');
  assert.equal(r.stats.verification.verified, 3);
});

test('epub: spine reading order is preserved', async () => {
  const r = await index(FIXTURE);
  assert.deepEqual(r.sections.map((s) => s.title), ['Introduction', 'Approach', 'Prior Work']);
});

test('epub: heading depth nests within a chapter', async () => {
  const r = await index(FIXTURE);
  const approach = r.structure.find((n) => n.title === 'Approach');
  assert.ok(approach?.nodes?.some((n) => n.title === 'Prior Work'), '<h2> nests under the chapter <h1>');
});

test('epub: retrieval finds the right chapter section', async () => {
  const r = await index(FIXTURE);
  const res = await query(r, 'How does PageIndex build a document structure?');
  assert.ok(res.sections.some((s) => s.title === 'Prior Work'));
  assert.match(res.context, /hundreds of LLM calls/);
});
