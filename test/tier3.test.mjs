/**
 * Tier 3 logic, exercised with deterministic mock LLMs.
 *
 * No provider is called anywhere in this suite. What is under test is the part
 * that must be right regardless of which model runs: batching, merging, window
 * filtering, and above all the refusal to overwrite an entry on weak evidence.
 *
 * Run: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../src/extract/pdf.mjs';
import { verifyAll, UNVERIFIED, VERIFIED } from '../src/structure/verify.mjs';
import { adjudicate, inferStructure } from '../src/structure/tier3.mjs';
import { index } from '../src/index.mjs';

const FIXTURE = 'bench/fixtures/brk.pdf'; // has genuinely unverifiable entries

/** Records every prompt it sees and replies with a canned result. */
const mockLLM = (handler) => {
  const prompts = [];
  return {
    prompts,
    json: async (prompt) => { prompts.push(prompt); return handler(prompt, prompts.length - 1); },
  };
};

const parseItems = (prompt) => [...prompt.matchAll(/--- item (\d+) ---/g)].map((m) => Number(m[1]));

test('adjudicate: batches many entries into few calls', async () => {
  const doc = await extract(FIXTURE);
  const { entries } = verifyAll(doc.outline, doc.pages);
  const pending = entries.filter((e) => e.status === UNVERIFIED);
  assert.ok(pending.length > 0, 'fixture should have unverified entries');

  const llm = mockLLM((prompt) => ({
    results: parseItems(prompt).map((id) => ({ id, starts_here: true, confident: true })),
  }));
  const res = await adjudicate(doc, entries, llm);

  assert.equal(res.calls, 1, 'a handful of entries must fit in one call');
  assert.equal(res.resolved, pending.length);
  assert.equal(res.entries.filter((e) => e.status === UNVERIFIED).length, 0);
});

test('adjudicate: an unconfident reply changes nothing', async () => {
  const doc = await extract(FIXTURE);
  const { entries } = verifyAll(doc.outline, doc.pages);
  const before = entries.map((e) => ({ page: e.page, status: e.status }));

  const llm = mockLLM((prompt) => ({
    results: parseItems(prompt).map((id) => ({ id, starts_here: false, page: 1, confident: false })),
  }));
  const res = await adjudicate(doc, entries, llm);

  assert.equal(res.resolved, 0);
  res.entries.forEach((e, i) => {
    assert.equal(e.page, before[i].page, 'page must not move on low confidence');
    assert.equal(e.status, before[i].status);
  });
});

test('adjudicate: refuses a move to a page that verifies worse', async () => {
  const doc = await extract(FIXTURE);
  const { entries } = verifyAll(doc.outline, doc.pages);
  const pending = entries.filter((e) => e.status === UNVERIFIED);

  // Confidently wrong: page 2 is a contents page, matching nothing.
  const llm = mockLLM((prompt) => ({
    results: parseItems(prompt).map((id) => ({ id, starts_here: false, page: 2, confident: true })),
  }));
  const res = await adjudicate(doc, entries, llm);

  const moved = res.entries.filter((e) => e.adjudicated === 'moved' && e.page === 2);
  assert.equal(moved.length, 0, 'a confident but unsupported move must be rejected');
  assert.equal(res.entries.filter((e) => e.status === UNVERIFIED).length, pending.length);
});

test('adjudicate: out-of-range pages are ignored', async () => {
  const doc = await extract(FIXTURE);
  const { entries } = verifyAll(doc.outline, doc.pages);
  const llm = mockLLM((prompt) => ({
    results: parseItems(prompt).map((id) => ({ id, starts_here: false, page: 99999, confident: true })),
  }));
  const res = await adjudicate(doc, entries, llm);
  assert.ok(res.entries.every((e) => e.page <= doc.numPages));
});

test('adjudicate: no LLM configured is a no-op', async () => {
  const doc = await extract(FIXTURE);
  const { entries } = verifyAll(doc.outline, doc.pages);
  const res = await adjudicate(doc, entries, null);
  assert.equal(res.calls, 0);
  assert.deepEqual(res.entries, entries);
});

test('inferStructure: drops headings outside the window that reported them', async () => {
  const doc = await extract('bench/fixtures/attn.pdf');
  const llm = mockLLM(() => ({
    headings: [
      { title: 'Real Heading', page: 1, level: 0 },
      { title: 'Out Of Range', page: 9999, level: 0 },
      { title: 'Not A Number', page: 'x', level: 0 },
      { title: '', page: 2, level: 0 },
    ],
  }));
  const res = await inferStructure(doc, llm);

  assert.ok(res.calls >= 1);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].title, 'Real Heading');
  assert.equal(res.entries[0].signal, 'llm');
});

test('inferStructure: deduplicates identical headings across overlapping windows', async () => {
  const doc = await extract('bench/fixtures/boe.pdf'); // large enough to need several windows
  const llm = mockLLM(() => ({ headings: [{ title: 'Repeated', page: 1, level: 0 }] }));
  const res = await inferStructure(doc, llm);
  assert.ok(res.calls > 1, 'a 220-page document must span multiple windows');
  assert.equal(res.entries.length, 1, 'the same page+title must collapse to one entry');
});

test('inferStructure: clamps level to a sane depth', async () => {
  const doc = await extract('bench/fixtures/attn.pdf');
  const llm = mockLLM(() => ({ headings: [{ title: 'Deep', page: 1, level: 99 }] }));
  const res = await inferStructure(doc, llm);
  assert.equal(res.entries[0].depth, 3);
});

test('index: tier 3 is not invoked when local verification suffices', async () => {
  const llm = mockLLM(() => { throw new Error('tier 3 must not run'); });
  const r = await index('bench/fixtures/attn.pdf', { llm });
  assert.equal(r.llm_calls, 0);
  assert.equal(llm.prompts.length, 0);
  assert.equal(r.tier, 'outline');
});

test('index: tier 3 resolves what local verification could not', async () => {
  const bare = await index(FIXTURE);
  assert.ok(bare.stats.verification.unverified > 0);

  const llm = mockLLM((prompt) => ({
    results: parseItems(prompt).map((id) => ({ id, starts_here: true, confident: true })),
  }));
  const r = await index(FIXTURE, { llm });

  assert.equal(r.stats.verification.unverified, 0);
  assert.equal(r.stats.adjudicated, bare.stats.verification.unverified);
  assert.equal(r.llm_calls, 1);
  assert.ok(r.llm_tokens > 0);
  assert.equal(r.stats.sections, bare.stats.sections, 'adjudication must not add or drop sections');
});
