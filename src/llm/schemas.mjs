/**
 * Zod schemas for every LLM job — the wire contract, expressed once.
 *
 * These are the correctness upgrade over PageIndex's approach. PageIndex asks
 * for JSON in the prompt and then repairs the reply with `extract_json()`,
 * which blind-replaces `'None' -> 'null'` and returns `{}` on any failure. Here
 * the schema is handed to `generateObject`, so decoding is grammar-constrained:
 * the model can only emit shapes that parse, and the provider retries a
 * malformed draft instead of us salvaging one.
 *
 * The two tier-3 shapes below mirror the JSON each tier-3 prompt already
 * declares in ../structure/tier3.mjs. Keep them in sync with those prompts —
 * the prompt is what the model reads, the schema is what the model must satisfy.
 *
 * Constraints are kept loose on purpose. OpenAI's strict structured outputs
 * reject numeric bounds (`minimum`/`maximum`) at the schema level, so `level`
 * is a bare integer here and ../structure/tier3.mjs clamps it to 0..3. Anything
 * a consumer already validates does not need to be re-encoded here.
 */
import { z } from 'zod';

/** One adjudication verdict — see ADJUDICATE_PROMPT in ../structure/tier3.mjs. */
const AdjudicationResult = z.object({
  id: z.number().int(),
  starts_here: z.boolean(),
  // Corrected page, or null when the section does not start on the claimed page
  // and the model cannot place it. Consumer guards with Number.isInteger.
  // Nullable but NOT optional: OpenAI strict structured outputs require every
  // property of an object to appear in `required`, so an absent-value field must
  // be nullable-and-required, never optional (an optional field 400s on OpenAI).
  page: z.number().int().nullable(),
  confident: z.boolean(),
});

/** One recovered heading — see INFER_PROMPT in ../structure/tier3.mjs. */
const InferredHeading = z.object({
  title: z.string(),
  page: z.number().int(),
  level: z.number().int(), // clamped to 0..3 by the consumer
});

export const AdjudicationSchema = z.object({ results: z.array(AdjudicationResult) });
export const HeadingsSchema = z.object({ headings: z.array(InferredHeading) });

/**
 * The default schema for the tier-3 `json(prompt)` method.
 *
 * `json` is a single method that serves two prompts — adjudication and
 * structure inference — and its interface takes only a prompt, so one schema
 * has to cover both. Both branches are `.nullable()` — required, never
 * `.optional()`: OpenAI's strict structured outputs require every property to
 * appear in `required`, and an optional branch 400s the request. Each tier-3
 * call fills its branch and leaves the other `null` (grammar-constrained, so the
 * model always emits both keys). The consumers read `reply?.results ?? []` and
 * `reply?.headings ?? []` — each reads only its own branch, so the unused null
 * (or any stray content the model puts there) is ignored.
 */
export const Tier3Schema = z.object({
  results: z.array(AdjudicationResult).nullable(),
  headings: z.array(InferredHeading).nullable(),
});

/**
 * Retrieval selection — the ids of the sections that can answer the question,
 * most relevant first. Ids are the node_id strings from the shortlist payload.
 */
export const SelectionSchema = z.object({ ids: z.array(z.string()) });
