/**
 * Pinned benchmark configuration (TASKS.md 2.3).
 *
 * Every published number names the exact model that produced it, so a third
 * party reproduces it against the same models. LLM outputs are not seed-
 * deterministic on these models (no temperature/seed knob on the current Opus),
 * so the LLM numbers are a single measured run, not an average — the README says
 * so, and the reproduction command is printed by `npm run bench:all`.
 */
// Phase-1 live-measured paths (bench/live-measure.mjs): tier-3 adjudication /
// structure inference and the retrieval-selection lift. Those README numbers were
// measured on this exact model — leave it pinned so they stay correctly attributed.
export const MODELS = {
  ours: 'claude-opus-4-8',
  baselineContext: 'claude-haiku-4-5',
  baselineEmbed: 'text-embedding-3-small',
  answer: 'claude-opus-4-8',
  grader: 'claude-opus-4-8',
};

// FinanceBench head-to-head (bench/financebench/run.mjs) runs on a GPT config.
// OpenAI is the funded provider, and grading the head-to-head with a third-party
// model — not the vendor whose recipe *is* the baseline — makes the comparison
// more neutral, not less. Embeddings are unchanged (the baseline was already
// OpenAI there). See financebench/README.md for the rationale.
export const FINANCEBENCH_MODELS = {
  ours: 'claude-sonnet-5',   // our library's retrieval select/answer (matches the answerer)
  baselineContext: 'gpt-4.1-mini', // cheap per-chunk contextualizer; 1M window fits a full 10-K
  baselineEmbed: 'text-embedding-3-small',
  answer: 'claude-sonnet-5', // answerer of record — both systems, for fairness
  grader: 'gpt-4o',          // neutral third-party judge (not the vendor whose recipe is the baseline)
  // Interim: the Anthropic account is unfunded, so runs pass `--answer-model gpt-4o`
  // for an all-OpenAI run. gpt-4o is a capable answerer; the choice shifts absolute
  // scores but not which retriever wins. Drop the flag once Anthropic is funded.
};

export const FIXTURES = ['boe', 'brk', 'gpt4', 'attn', 'bert'];
