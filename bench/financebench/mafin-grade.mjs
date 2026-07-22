/**
 * PageIndex / Mafin 2.5's own grader, ported verbatim.
 *
 * The 98.7% FinanceBench headline is produced by *this* judge, not ours. To
 * compare on their terms we reproduce their `check_answer_equivalence` prompt
 * exactly (VectifyAI/Mafin2.5-FinanceBench, eval.py) — a lenient LLM judge that
 * accepts an answer if the gold "can be inferred or generated from" it, with
 * rounding and format tolerance. Their default judge model is gpt-4o
 * (`gpt-4o-2024-11-20`), temperature 0; the free-text reply is parsed for
 * true/false, again exactly as they do.
 *
 * Their published headline additionally OR's this judge across three models
 * (gpt-4o, o1-mini, o3-mini) and takes `any()` — see `--hybrid` note in the
 * runner. We default to the single-judge protocol (their eval.py __main__) and
 * apply the *identical* judge to both systems, so any leniency applies equally.
 */
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { record, guard } from '../meter.mjs';

const openai = createOpenAI();
const anthropic = createAnthropic();
const chat = (id) => (/claude/i.test(id) ? anthropic(id) : openai(id));

/** Verbatim from Mafin2.5-FinanceBench/eval.py::check_answer_equivalence. */
const prompt = (question, gold, answer) => {
  const query_prompt = question ? `- Query: ${question}` : '';
  return `
    You are an expert evaluator for AI-generated responses to queries. Your task is to determine whether the AI-generated answer correctly answers the query based on the golden answer provided by a human expert.

    Numerical Accuracy:
    - Rounding differences should be **ignored** if they do not meaningfully change the conclusion.
    - You can allow some flexibility in accuracy. For example, 1.2 is considered similar to 1.23. Two numbers are considered similar if one can be rounded to the other.
    - Fractions, percentage, and numerics could be considered similar, for example: "11 of 14" is considered equivalent to "79%" and "0.79".

    Evaluation Criteria:
    - If the golden answer or any of its equivalence can be inferred or generated from the AI-generated answer, then the AI-generated answer is considered correct.
    - If any number, percentage, fraction, or figure in the golden answer is not present in the AI-generated answer, but can be inferred or generated from the AI-generated answer or implicitly exist in the AI-generated answer, then the AI-generated answer is considered correct.
    - The AI-generated answer is considered correct if it conveys the same or similar meaning, conclusion, or rationale as the golden answer.
    - If the AI-generated answer is a superset of the golden answer, it is also considered correct.
    - If the AI-generated answer provides a valid answer or reasonable interpretation compared to the golden answer, it is considered correct.
    - If the AI-generated answer contains subjective judgments or opinions, it is considered correct as long as they are reasonable and justifiable compared to the golden answer.

    - Otherwise, the AI-generated answer is incorrect.

    Inputs:
    ${query_prompt}
    - AI-Generated Answer: ${answer}
    - Golden Answer: ${gold}

    Your output should be ONLY a boolean value: \`True\` or \`False\`, nothing else.
    `;
};

/**
 * Grade with PageIndex's own judge. Returns { correct, reason } to match the
 * shape of ./grade.mjs (our strict grader), so the runner treats them alike.
 * `reason` carries the raw verdict token for auditability.
 * @returns {{correct: boolean, reason: string}}
 */
export async function mafinGrade(question, gold, candidate, opts = {}) {
  const model = opts.graderModel || 'gpt-4o';
  guard();
  const { text, usage } = await generateText({
    model: chat(model),
    temperature: 0,
    maxRetries: 3,
    prompt: prompt(question, gold, candidate ?? ''),
  });
  record(model, usage);
  const low = (text || '').toLowerCase();
  // Their parse order: check "true" first, then "false". A reply containing
  // neither (rare) is treated as incorrect, the conservative default.
  const correct = low.includes('true') ? true : low.includes('false') ? false : false;
  return { correct, reason: (text || '').trim().slice(0, 40) };
}
