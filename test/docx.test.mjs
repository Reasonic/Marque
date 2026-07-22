/**
 * DOCX extraction — a Word document's paragraph styles ("Heading 1/2", "Title")
 * are its outline, so a binary Office format still resolves at tier 1 with no LLM.
 * Guards the zero-dependency ZIP reader and the OOXML style parsing.
 *
 * The fixture (test/fixtures/sample.docx) is a spec-shaped .docx generated with
 * real heading styles and independently validated with the system `unzip`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { index, query, extract } from '../src/index.mjs';
import { readZipEntry } from '../src/extract/zip.mjs';

const FIXTURE = 'test/fixtures/sample.docx';

test('docx: heading styles resolve at tier 1, fully verified, no LLM', async () => {
  const r = await index(FIXTURE);
  assert.equal(r.tier, 'outline');
  assert.equal(r.llm_calls, 0);
  assert.equal(r.stats.sections, 4, 'Title + two Heading1 + one Heading2');
  assert.equal(r.stats.verification.verified, 4);
  assert.equal(r.stats.verification.unverified, 0);
});

test('docx: heading depth follows the style level', async () => {
  const r = await index(FIXTURE);
  const background = r.structure.find((n) => n.title === 'Background');
  assert.ok(background?.nodes?.some((n) => n.title === 'Prior Work'), 'Heading2 nests under Heading1');
});

test('docx: run text is concatenated and XML entities decoded', async () => {
  const doc = await extract(FIXTURE);
  assert.match(doc.fullText, /cost & infrastructure/, '&amp; → & in a <w:t> run');
});

test('docx: retrieval finds the right section', async () => {
  const r = await index(FIXTURE);
  const res = await query(r, 'How does PageIndex build a document structure?');
  assert.ok(res.sections.some((s) => s.title === 'Prior Work'));
  assert.match(res.context, /hundreds of LLM calls/);
});

test('zip: reader extracts an entry byte-for-byte', () => {
  const xml = readZipEntry(fs.readFileSync(FIXTURE), 'word/document.xml').toString('utf8');
  assert.match(xml, /<w:document/);
  assert.match(xml, /w:val="Heading1"/);
  assert.throws(() => readZipEntry(fs.readFileSync(FIXTURE), 'no/such/part.xml'), /not found/);
});
