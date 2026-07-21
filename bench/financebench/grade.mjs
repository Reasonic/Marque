/**
 * Strict-agreement grader.
 *
 * FinanceBench's headline should be *strict agreement* — does the answer convey
 * the same fact/number as the gold answer — not a vendor-adjudicated figure. One
 * grader model, one prompt, applied identically to every system under test, so
 * the comparison is fair. The grader is deliberately strict: a different number,
 * a wrong sign, or a hedge that never commits to the value is incorrect.
 */
import { generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { record, guard } from '../meter.mjs';

const anthropic = createAnthropic();
const openai = createOpenAI();

/** Route a grader model id to its provider (Claude → Anthropic, else → OpenAI). */
const chat = (id) => (/claude/i.test(id) ? anthropic(id) : openai(id));

const VERDICT = z.object({
  correct: z.boolean(),
  reason: z.string(),
});

const PROMPT = `You are grading whether a candidate answer matches the gold answer to a financial question.

Mark it correct only if the candidate conveys the same key fact or number as the gold answer. Allow differences in formatting, rounding to the same precision, units expressed equivalently, and extra correct context. Mark it incorrect if the number differs, the sign or magnitude is wrong, the candidate hedges without committing to the gold value, or it says the information is unavailable when the gold answer is a specific value.

This is strict agreement: when in doubt, mark incorrect.`;

/**
 * @returns {{correct: boolean, reason: string}}
 */
export async function grade(question, gold, candidate, opts = {}) {
  const model = opts.graderModel || 'gpt-4o';
  guard();
  const { object, usage } = await generateObject({
    model: chat(model),
    schema: VERDICT,
    maxRetries: 3,
    prompt: `${PROMPT}\n\nQuestion:\n${question}\n\nGold answer:\n${gold}\n\nCandidate answer:\n${candidate}`,
  });
  record(model, usage);
  return object;
}
