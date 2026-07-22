/**
 * Markdown extraction — the first non-PDF format. Structure is explicit (ATX
 * headings), so it must resolve at tier 1, exactly, with zero LLM calls, and feed
 * retrieval unchanged. These guard the format dispatcher and the adapter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { index, query, extract } from '../src/index.mjs';

const FIXTURE = 'test/fixtures/sample.md';

test('markdown: resolves at tier 1, fully verified, no LLM', async () => {
  const r = await index(FIXTURE);
  assert.equal(r.tier, 'outline', 'ATX headings are read as the outline (tier 1)');
  assert.equal(r.llm_calls, 0);
  assert.equal(r.stats.sections, 6);
  assert.equal(r.stats.verification.verified, 6, 'every heading verifies on its own section');
  assert.equal(r.stats.verification.unverified, 0);
});

test('markdown: nesting follows heading depth', async () => {
  const r = await index(FIXTURE);
  const top = r.structure.find((n) => n.title === 'Vectorless RAG');
  const background = top.nodes.find((n) => n.title === 'Background');
  assert.ok(background, '## Background nests under # Vectorless RAG');
  assert.ok(background.nodes?.some((n) => n.title === 'Prior Work'), '### Prior Work nests under ## Background');
});

test('markdown: a heading inside a code fence is not a section', async () => {
  const doc = await extract(FIXTURE);
  assert.ok(!doc.outline.some((e) => /shell comment/.test(e.title)), 'the `# shell comment` in a bash block is ignored');
});

test('markdown: retrieval finds the right section', async () => {
  const r = await index(FIXTURE);
  const res = await query(r, 'How does PageIndex build a document structure?');
  assert.ok(res.sections.some((s) => s.title === 'Prior Work'), 'the PageIndex passage lives under Prior Work');
  assert.match(res.context, /hundreds of LLM calls/, 'its evidence reaches the answering context');
});

test('markdown: a document with no headings still retrieves as one unit', async () => {
  const tmp = path.join(os.tmpdir(), `marque-noheading-${process.pid}.md`);
  fs.writeFileSync(tmp, 'This document has no headings at all. It is several sentences of ordinary '
    + 'prose describing how structure-first retrieval still covers a body with no '
    + 'outline, by treating the uncovered span as a single retrieval unit rather '
    + 'than leaving the text unreachable to any query that arrives later.\n');
  try {
    const r = await index(tmp);
    const res = await query(r, 'what is this about?');
    assert.match(res.context, /no headings/, 'the body is covered by a gap unit and remains retrievable');
  } finally { fs.rmSync(tmp, { force: true }); }
});
