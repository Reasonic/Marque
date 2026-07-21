/**
 * Structure fixes that must hold on real documents (TASKS.md 1.4, 1.5).
 *
 * Both are fixture-driven and deterministic — no LLM, no network. They guard
 * against the two ways a locally-built tree quietly goes wrong: a wrapped
 * heading fragmenting into several sections, and a final section with no
 * following entry swallowing the back matter.
 *
 * Run: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { index } from '../src/index.mjs';
import { extract } from '../src/extract/pdf.mjs';
import { detectHeadings, detectTrailingMatter } from '../src/structure/headings.mjs';

// --- 1.4 multi-line headings ------------------------------------------------

test('1.4: a wrapped multi-line heading is one section, not three', async () => {
  const r = await index('bench/fixtures/bert.pdf');
  const appendixTitle = r.sections.filter((e) => /^Appendix for/.test(e.title));

  assert.equal(appendixTitle.length, 1, 'BERT’s three-line appendix title must collapse to one entry');
  // The merge must span all three physical lines, ending on the last one.
  assert.match(appendixTitle[0].title, /Pre-training/);
  assert.match(appendixTitle[0].title, /Language Understanding/);
});

test('1.4: the merge stops at a real heading, not across it', async () => {
  // "A Additional Details for BERT" sits 13 lines away, in the next column, and
  // carries its own appendix signal. It must survive as a separate section —
  // this is the guard that a column break / strong signal is never absorbed.
  const r = await index('bench/fixtures/bert.pdf');
  assert.ok(
    r.sections.some((e) => /^A Additional Details for BERT/.test(e.title)),
    'the real appendix heading must not be fused into the wrapped title',
  );
});

test('1.4: a distinct heading on non-consecutive lines is never merged', () => {
  // Two headings with body text between them share size/page but are not on
  // consecutive lines, so they must stay separate.
  const doc = {
    lines: [
      { page: 2, y: 700, size: 14, bold: true, text: 'First Heading' },
      { page: 2, y: 680, size: 10, bold: false, text: 'a long line of ordinary body copy that dominates the page by character count' },
      { page: 2, y: 660, size: 10, bold: false, text: 'a second long line of body copy so ten point is unambiguously the body size' },
      { page: 2, y: 640, size: 14, bold: true, text: 'Second Heading' },
    ],
  };
  const titles = detectHeadings(doc).map((c) => c.title);
  assert.deepEqual(titles, ['First Heading', 'Second Heading']);
});

// --- 1.5 trailing matter ----------------------------------------------------

test('1.5: the final section stops before the references, not at doc end', async () => {
  const r = await index('bench/fixtures/attn.pdf');
  const conclusion = r.sections.find((e) => e.title === 'Conclusion');
  const references = r.sections.find((e) => /^References/.test(e.title));

  assert.ok(references, 'a References boundary is added to the tier-1 outline');
  assert.ok(conclusion.charEnd <= references.charStart, 'Conclusion must end where References begins');
  assert.ok(
    conclusion.charEnd < r._doc.fullText.length,
    'Conclusion must no longer run to the end of the document',
  );
});

test('1.5: back matter already in the outline is not duplicated', async () => {
  // gpt4.pdf lists References and Appendix in its embedded outline; the
  // typography pass must dedupe against them.
  const r = await index('bench/fixtures/gpt4.pdf');
  assert.equal(r.sections.filter((e) => /^References\b/.test(e.title)).length, 1);
  assert.equal(r.sections.filter((e) => /^Appendix\b/.test(e.title)).length, 1);
});

test('1.5: detectTrailingMatter ignores headings before the last entry', async () => {
  const doc = await extract('bench/fixtures/attn.pdf');
  // Last entry sits on the final page — nothing legitimately trails it.
  const none = detectTrailingMatter(doc, [{ title: 'Anything', page: doc.numPages }]);
  assert.equal(none.length, 0);
});

// --- 1.3 a fixture that needs tier 3 ---------------------------------------

const TIER3_FIXTURE = 'test/fixtures/tier3.pdf'; // no outline, uniform typography

test('1.3: the fixture has no structure the cheap tiers can read', async () => {
  const doc = await extract(TIER3_FIXTURE);
  assert.equal(doc.outline.length, 0, 'no embedded outline → tier 1 finds nothing');
  assert.equal(detectHeadings(doc).length, 0, 'uniform typography → tier 2 finds nothing');

  // With no LLM, there is simply no structure — which is what forces tier 3.
  const bare = await index(TIER3_FIXTURE);
  assert.equal(bare.tier, 'headings');
  assert.equal(bare.stats.sections, 0);
});

test('1.3: with an LLM the fixture resolves at tier 3', async () => {
  // Deterministic mock over the fixed { json } interface — no provider, no key.
  const llm = { json: async () => ({ headings: [
    { title: 'Overview', page: 1, level: 0 },
    { title: 'Cache Coherence', page: 1, level: 0 },
  ] }) };

  const r = await index(TIER3_FIXTURE, { llm });
  assert.equal(r.tier, 'llm', 'inferStructure ran and supplied the structure');
  assert.ok(r.llm_calls > 0);
  assert.ok(r.stats.sections > 0, 'headings were recovered from the body text');
});
