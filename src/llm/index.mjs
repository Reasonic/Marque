/**
 * Provider adapters — the only place that talks to a live model.
 *
 * Two interfaces are already fixed by their consumers, and this module satisfies
 * both from one config:
 *
 *   { json(prompt) }                 tier 3      ../structure/tier3.mjs
 *   { select(prompt, k), answer(p) } retrieval   ../retrieve/query.mjs
 *
 * Everything goes through the Vercel AI SDK: `generateObject` with a Zod schema
 * for the JSON paths (grammar-constrained decoding, not prompt-and-regex — see
 * ./schemas.mjs), `generateText` for the free-form answer. One provider is
 * chosen per config; OpenAI and Anthropic are interchangeable behind it.
 *
 * `ai@7` is ESM-only and needs Node >=22, which matches the package engines.
 */
import { generateObject, generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { Tier3Schema, SelectionSchema } from './schemas.mjs';

export * from './schemas.mjs';

const DEFAULT_MODELS = { anthropic: 'claude-opus-4-8', openai: 'gpt-4o' };

/**
 * Neutralize control-token lookalikes at the provider boundary. PDFs contain
 * literal strings like `<|endofprompt|>` (the GPT-4 technical report does);
 * gpt-tokenizer crashes on them and a provider may treat them specially. A
 * zero-width space after the `<` breaks the token without changing what the
 * model reads. Mirrors the countTokens guard in ../retrieve/payload.mjs.
 */
export const sanitize = (s) => String(s).replace(/<\|/g, '<\u200b|');

function inferProvider(opts) {
  if (opts.provider) return opts.provider;
  if (opts.apiKey) return 'anthropic'; // key given but provider unstated
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  throw new Error(
    'marque: no LLM provider configured. Set ANTHROPIC_API_KEY or '
    + 'OPENAI_API_KEY, or pass { provider, apiKey } to createLLM().',
  );
}

/**
 * Resolve config into an AI SDK LanguageModel. A pre-built model instance is
 * passed straight through — used by tests (MockLanguageModelV4) and by callers
 * who want a provider this module does not wire up.
 */
function resolveModel(opts) {
  if (opts.model && typeof opts.model === 'object' && opts.model.specificationVersion) {
    return opts.model;
  }

  const provider = inferProvider(opts);
  const modelId = (typeof opts.model === 'string' && opts.model) || DEFAULT_MODELS[provider];
  const settings = opts.apiKey ? { apiKey: opts.apiKey } : {};

  if (provider === 'anthropic') return createAnthropic(settings)(modelId);
  if (provider === 'openai') return createOpenAI(settings)(modelId);
  throw new Error(
    `marque: unsupported provider "${provider}". Use "anthropic" or `
    + '"openai", or pass a pre-built AI SDK model as { model }.',
  );
}

/**
 * @param {object} [opts]
 * @param {'anthropic'|'openai'} [opts.provider] defaults from whichever API key env is set
 * @param {string|object} [opts.model] model id, or a pre-built AI SDK LanguageModel
 * @param {string} [opts.apiKey] overrides the provider's env key
 * @param {number} [opts.maxRetries=2] retries on transient provider errors
 * @param {number} [opts.maxOutputTokens=4096]
 * @param {(u: {model: string, usage: object, kind: string}) => void} [opts.onUsage]
 *   optional per-call token-usage hook, for cost accounting
 * @returns {{
 *   json: (prompt: string, schema?: object) => Promise<any>,
 *   select: (prompt: string, k?: number) => Promise<string[]>,
 *   answer: (prompt: string) => Promise<string>,
 *   model: object,
 * }}
 */
export function createLLM(opts = {}) {
  const model = resolveModel(opts);
  const maxRetries = opts.maxRetries ?? 2;
  const maxOutputTokens = opts.maxOutputTokens ?? 4096;
  const report = (usage, kind) => opts.onUsage?.({ model: model.modelId, usage, kind });

  return {
    /**
     * Tier 3. One grammar-constrained call; the default schema covers both
     * tier-3 shapes (adjudication and structure inference) so the fixed
     * `json(prompt)` interface serves both. Callers may pass a narrower schema.
     */
    async json(prompt, schema = Tier3Schema) {
      const { object, usage } = await generateObject({
        model, schema, maxRetries, maxOutputTokens, prompt: sanitize(prompt),
      });
      report(usage, 'json');
      return object;
    },

    /**
     * Retrieval selection. Returns the node-id strings of the sections most
     * likely to answer the question, most relevant first, capped at k. The
     * payload already carries the instruction and candidate list; we do not
     * append to it, so the question stays last for prompt-cache reuse.
     */
    async select(prompt, k = 4) {
      const { object, usage } = await generateObject({
        model, schema: SelectionSchema, maxRetries, maxOutputTokens, prompt: sanitize(prompt),
      });
      report(usage, 'select');
      return (object?.ids ?? []).slice(0, k);
    },

    /** Retrieval answering. Free-form, citable prose over the provided sections. */
    async answer(prompt) {
      const { text, usage } = await generateText({
        model, maxRetries, maxOutputTokens, prompt: sanitize(prompt),
      });
      report(usage, 'answer');
      return text;
    },

    model,
  };
}
