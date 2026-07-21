/**
 * Provider adapters, exercised with the AI SDK's own mock model.
 *
 * These do not hit a network. What is under test is the adapter surface that
 * must be right regardless of provider: schema-constrained decoding through
 * real Zod validation, the mapping to each fixed interface, config resolution
 * across OpenAI and Anthropic, and the control-token guard at the boundary.
 * Live provider coverage is TASKS.md 1.2.
 *
 * Run: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4 } from 'ai/test';
import { createLLM } from '../src/llm/index.mjs';
import { extract } from '../src/extract/pdf.mjs';
import { verifyAll, UNVERIFIED } from '../src/structure/verify.mjs';
import { adjudicate } from '../src/structure/tier3.mjs';

/** Flatten the AI SDK prompt (message[]) back into the text the model sees. */
const promptText = (prompt) =>
  prompt
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ text: m.content }]))
    .map((c) => c.text ?? '')
    .join('\n');

/**
 * A MockLanguageModelV4 that records every prompt and replies with a canned
 * result. Objects are JSON-encoded so generateObject validates them against the
 * real schema — exactly the path a live provider takes.
 */
function mockModel(handler) {
  const prompts = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const text = promptText(options.prompt);
      prompts.push(text);
      const reply = handler(text, prompts.length - 1);
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

test('json: returns the adjudication shape, schema-validated', async () => {
  const { model } = mockModel(() => ({
    results: [{ id: 0, starts_here: true, page: null, confident: true }],
    headings: null,
  }));
  const reply = await createLLM({ model }).json('adjudicate these items');
  assert.deepEqual(reply.results, [{ id: 0, starts_here: true, page: null, confident: true }]);
});

test('json: returns the inferred-headings shape', async () => {
  const { model } = mockModel(() => ({ results: null, headings: [{ title: 'Introduction', page: 1, level: 0 }] }));
  const reply = await createLLM({ model }).json('extract headings');
  assert.equal(reply.headings[0].title, 'Introduction');
});

test('json: accepts the null unused branch that strict outputs emit', async () => {
  // OpenAI strict mode makes every field required and returns the unused branch
  // as null, not absent. The combined schema must accept that.
  const { model } = mockModel(() => ({
    results: [{ id: 0, starts_here: true, page: null, confident: true }],
    headings: null,
  }));
  const reply = await createLLM({ model }).json('adjudicate');
  assert.equal(reply.results.length, 1);
  assert.equal(reply.headings, null);
});

test('json: a malformed field is rejected, not salvaged', async () => {
  // starts_here must be a boolean. generateObject retries then throws — unlike
  // PageIndex's extract_json(), which returns {} and lets bad data through.
  const { model } = mockModel(() => ({ results: [{ id: 0, starts_here: 'yes', confident: true }] }));
  await assert.rejects(createLLM({ model, maxRetries: 0 }).json('adjudicate'));
});

test('select: returns node ids, capped at k', async () => {
  const { model } = mockModel(() => ({ ids: ['0007', '0012', '0020'] }));
  const ids = await createLLM({ model }).select('select payload', 2);
  assert.deepEqual(ids, ['0007', '0012']);
});

test('answer: returns free-form text', async () => {
  const { model } = mockModel(() => 'The answer is in section [0007].');
  const answer = await createLLM({ model }).answer('answer the question');
  assert.equal(answer, 'The answer is in section [0007].');
});

test('sanitize: control-token lookalikes never reach the provider raw', async () => {
  const { model, prompts } = mockModel(() => ({ results: [], headings: null }));
  await createLLM({ model }).json('a page containing <|endofprompt|> verbatim');
  assert.ok(!/<\|/.test(prompts[0]), 'raw <| must be broken before it is sent');
  assert.ok(prompts[0].includes('<\u200b|'), 'the token boundary is split with a zero-width space');
});

test('config: one config drives both providers, with defaults', () => {
  const anthropic = createLLM({ provider: 'anthropic', apiKey: 'sk-test' });
  assert.equal(anthropic.model.modelId, 'claude-opus-4-8');

  const openai = createLLM({ provider: 'openai', apiKey: 'sk-test' });
  assert.equal(openai.model.modelId, 'gpt-4o');

  const custom = createLLM({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-haiku-4-5' });
  assert.equal(custom.model.modelId, 'claude-haiku-4-5');
});

test('config: unconfigured provider fails with guidance', () => {
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY } = process.env;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => createLLM(), /no LLM provider configured/);
  } finally {
    if (ANTHROPIC_API_KEY !== undefined) process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
    if (OPENAI_API_KEY !== undefined) process.env.OPENAI_API_KEY = OPENAI_API_KEY;
  }
});

test('tier 3: the adapter drives adjudicate end to end', async () => {
  const doc = await extract('bench/fixtures/brk.pdf');
  const { entries } = verifyAll(doc.outline, doc.pages);
  const pending = entries.filter((e) => e.status === UNVERIFIED);
  assert.ok(pending.length > 0, 'fixture should have unverified entries');

  const { model } = mockModel((text) => ({
    results: [...text.matchAll(/--- item (\d+) ---/g)].map((m) => ({
      id: Number(m[1]), starts_here: true, page: null, confident: true,
    })),
    headings: null,
  }));
  const res = await adjudicate(doc, entries, createLLM({ model }));

  assert.equal(res.resolved, pending.length);
  assert.equal(res.entries.filter((e) => e.status === UNVERIFIED).length, 0);
});
