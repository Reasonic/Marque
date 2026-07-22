/**
 * Multi-document routing (indexCorpus / queryCorpus).
 *
 * The shipped sample fixtures are deliberately near-identical (the hard routing
 * case), so these tests write a few *distinct* documents to a temp dir and check
 * that a question reaches the right one — first with no LLM (deterministic BM25
 * routing + selection, zero tokens), then through the AI SDK's mock model for the
 * select/answer path. Run: node --test test/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { indexCorpus, queryCorpus, createLLM } from '../src/index.mjs';

const DOCS = {
  'planets.md': `# The Solar System

## Planets
Mercury, Venus, Earth, and Mars are the inner rocky planets.

## Orbits
Planets orbit the Sun on elliptical paths, held by gravitation.
`,
  'cooking.md': `# French Cuisine

## Mother Sauces
Béchamel is a white sauce made from a roux of butter and flour with milk.

## Pastry
A croissant is a laminated dough of many butter layers.
`,
  'networking.md': `# TCP Networking

## Handshake
A connection opens with a three-way SYN, SYN-ACK, ACK exchange.

## Congestion Control
The window shrinks on packet loss to avoid collapse.
`,
};

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marque-corpus-'));
  for (const [name, body] of Object.entries(DOCS)) fs.writeFileSync(path.join(dir, name), body);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const paths = () => Object.keys(DOCS).map((n) => path.join(dir, n));

/** Flatten the AI SDK prompt (message[]) back into the text the model sees. */
const promptText = (prompt) => prompt
  .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ text: m.content }]))
  .map((c) => c.text ?? '')
  .join('\n');

/** Mock model: expand → none, select → the first shortlisted id, answer → canned. */
function corpusMock() {
  const prompts = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const text = promptText(options.prompt);
      prompts.push(text);
      let reply;
      if (/extra search terms/i.test(text)) reply = '';
      else if (/selecting which passages/i.test(text)) {
        const m = text.match(/"id":"([^"]+)"/);
        reply = { ids: m ? [m[1]] : [] };
      } else reply = 'Answer grounded in the provided sections.';
      return {
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

test('indexCorpus: indexes every document at a cheap tier, no LLM', async () => {
  const corpus = await indexCorpus(paths());
  assert.equal(corpus.documents.length, 3);
  for (const d of corpus.documents) {
    assert.equal(d.tier, 'outline'); // markdown headings resolve at tier 1
    assert.equal(d.llm_calls, 0);
    assert.ok(d.sections >= 2);
  }
});

test('indexCorpus: rejects an empty corpus', async () => {
  await assert.rejects(() => indexCorpus([]), /non-empty array/);
});

test('queryCorpus: routes to the right document, zero LLM', async () => {
  const corpus = await indexCorpus(paths());
  const res = await queryCorpus(corpus, 'how do planets orbit the sun?');
  assert.equal(res.routed_documents[0], 'planets.md');
  assert.equal(res.selection_by, 'bm25');
  assert.equal(res.tokens.llm_calls, 0);
  assert.ok(res.sections.length > 0);
  assert.equal(res.sections[0].doc, 'planets.md'); // top section is from the routed file
});

test('queryCorpus: a different topic routes to a different document', async () => {
  const corpus = await indexCorpus(paths());
  const sauce = await queryCorpus(corpus, 'what is a béchamel sauce made from?');
  assert.equal(sauce.routed_documents[0], 'cooking.md');
  const net = await queryCorpus(corpus, 'explain the TCP three-way handshake');
  assert.equal(net.routed_documents[0], 'networking.md');
});

test('queryCorpus: with an LLM, select and answer run and the citation is namespaced by document', async () => {
  const { model, prompts } = corpusMock();
  const llm = createLLM({ model });
  const corpus = await indexCorpus(paths());
  const res = await queryCorpus(corpus, 'how do planets orbit the sun?', { llm });
  assert.equal(res.selection_by, 'llm');
  assert.equal(res.answer, 'Answer grounded in the provided sections.');
  assert.ok(res.sections.every((s) => s.doc === 'planets.md'));
  // expand + select + answer = 3 calls; the answer context cites doc##node ids.
  assert.equal(res.tokens.llm_calls, 3);
  assert.match(res.context, /\[planets\.md##/);
  assert.ok(prompts.some((p) => /selecting which passages/i.test(p)));
});

test('indexCorpus: duplicate basenames are disambiguated', async () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'marque-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'marque-b-'));
  try {
    fs.writeFileSync(path.join(a, 'report.md'), '# Alpha\n\n## One\nalpha body\n');
    fs.writeFileSync(path.join(b, 'report.md'), '# Beta\n\n## Two\nbeta body\n');
    const corpus = await indexCorpus([path.join(a, 'report.md'), path.join(b, 'report.md')]);
    const names = corpus.documents.map((d) => d.doc_name);
    assert.deepEqual(names, ['report.md', 'report.md#2']);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
