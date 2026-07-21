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
  page: z.number().int().nullable().optional(),
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
 * has to cover both. Whichever the prompt asks for is filled, the other is left
 * out. Both branches are `.nullable().optional()`: Anthropic's tool mode omits
 * the unused branch (undefined), while OpenAI's strict outputs make every field
 * required and return the unused one as null. The consumers read
 * `reply?.results ?? []` and `reply?.headings ?? []`, so either is a no-op.
 */
export const Tier3Schema = z.object({
  results: z.array(AdjudicationResult).nullable().optional(),
  headings: z.array(InferredHeading).nullable().optional(),
});

/**
 * Retrieval selection — the ids of the sections that can answer the question,
 * most relevant first. Ids are the node_id strings from the shortlist payload.
 */
export const SelectionSchema = z.object({ ids: z.array(z.string()) });
