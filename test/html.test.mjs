/**
 * HTML extraction — `<h1>`–`<h6>` state the structure, so it resolves at tier 1
 * with no LLM. Guards the dispatcher, tag/entity handling, and the fold of
 * pre-heading content into the first section.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { index, query, extract } from '../src/index.mjs';

const FIXTURE = 'test/fixtures/sample.html';

test('html: resolves at tier 1, fully verified, no LLM', async () => {
  const r = await index(FIXTURE);
  assert.equal(r.tier, 'outline');
  assert.equal(r.llm_calls, 0);
  assert.equal(r.stats.verification.verified, r.stats.sections, 'every heading verifies');
  assert.equal(r.stats.verification.unverified, 0);
});

test('html: script/style content is not mistaken for structure', async () => {
  const doc = await extract(FIXTURE);
  assert.ok(!doc.outline.some((e) => /not a real heading/.test(e.title)), 'a <h2> inside <script> is ignored');
  assert.ok(!doc.fullText.includes('display: none'), '<style> content is stripped');
});

test('html: entities are decoded', async () => {
  const doc = await extract(FIXTURE);
  assert.ok(doc.fullText.includes('Embeddings & vector'), '&amp; → &');
  assert.ok(doc.fullText.includes('document’s structure'), '&rsquo; → ’');
});

test('html: nesting follows heading levels', async () => {
  const r = await index(FIXTURE);
  const top = r.structure.find((n) => n.title === 'Vectorless RAG');
  const background = top?.nodes?.find((n) => n.title === 'Background');
  assert.ok(background?.nodes?.some((n) => n.title === 'Prior Work'), '<h3> nests under <h2> under <h1>');
});

test('html: pre-heading lead paragraph folds into the first section, not a phantom node', async () => {
  const r = await index(FIXTURE);
  const topLevel = r.structure.filter((n) => n.title === 'Vectorless RAG');
  assert.equal(topLevel.length, 1, 'the <title>-named lead is not a duplicate top node');
  assert.match(r._doc.fullText, /Structure-first document indexing/, 'the lead paragraph is retained');
});

test('html: retrieval finds the right section', async () => {
  const r = await index(FIXTURE);
  const res = await query(r, 'How does PageIndex build a document structure?');
  assert.ok(res.sections.some((s) => s.title === 'Prior Work'));
  assert.match(res.context, /hundreds of LLM calls/);
});
