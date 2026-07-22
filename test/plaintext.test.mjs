/**
 * Plain-text extraction — the heuristic hard case. Structure is inferred from
 * conventions (Setext underlines, section numbering, ALL-CAPS, Chapter/Section
 * keywords), so the tests are adversarial: the right headings are found AND the
 * lookalikes (a numbered sentence, an acronym in body text, a lead paragraph) are
 * rejected. Biased toward under-detection — a false positive corrupts the index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { index, query } from '../src/index.mjs';

const FIXTURE = 'test/fixtures/sample.txt';

test('txt: each heading convention is detected, and verified', async () => {
  const r = await index(FIXTURE);
  assert.equal(r.llm_calls, 0);
  const titles = r.sections.map((s) => s.title);
  assert.ok(titles.includes('Vectorless RAG'), 'Setext === underline');
  assert.ok(titles.includes('1. Background'), 'section number');
  assert.ok(titles.includes('1.1 Prior Work'), 'sub-section number');
  assert.ok(titles.includes('METHODOLOGY'), 'ALL-CAPS line after a blank');
  assert.ok(titles.includes('Chapter 4: Conclusion'), 'Chapter keyword');
  assert.equal(r.stats.verification.verified, r.stats.sections, 'each detected heading verifies');
});

test('txt: lookalikes are NOT headings', async () => {
  const r = await index(FIXTURE);
  const js = JSON.stringify(r.structure);
  assert.ok(!js.includes('full sentence'), 'a numbered list item that is a sentence is not a heading');
  assert.ok(!js.includes('acronyms'), 'an acronym in a body line is not a heading');
  assert.ok(!js.includes('lead paragraph'), 'a long lead paragraph is not a heading');
});

test('txt: sub-section numbering nests', async () => {
  const r = await index(FIXTURE);
  const bg = r.structure.find((n) => n.title === '1. Background');
  assert.ok(bg?.nodes?.some((n) => n.title === '1.1 Prior Work'), '1.1 nests under 1.');
});

test('txt: retrieval finds the right section', async () => {
  const r = await index(FIXTURE);
  const res = await query(r, 'How does PageIndex build a document structure?');
  assert.ok(res.sections.some((s) => s.title === '1.1 Prior Work'));
  assert.match(res.context, /hundreds of LLM calls/);
});

test('txt: prose with no detectable headings still retrieves', async () => {
  const tmp = path.join(os.tmpdir(), `marque-plain-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'This file is ordinary running prose with no headings, numbering, or '
    + 'underlines of any kind, just several sentences that describe retrieval so the '
    + 'body remains reachable as a single gap unit rather than being lost entirely.\n');
  try {
    const res = await query(await index(tmp), 'what does it describe?');
    assert.match(res.context, /reachable as a single gap unit/);
  } finally { fs.rmSync(tmp, { force: true }); }
});
