/**
 * Pinned benchmark configuration (TASKS.md 2.3).
 *
 * Every published number names the exact model that produced it, so a third
 * party reproduces it against the same models. LLM outputs are not seed-
 * deterministic on these models (no temperature/seed knob on the current Opus),
 * so the LLM numbers are a single measured run, not an average — the README says
 * so, and the reproduction command is printed by `npm run bench:all`.
 */
export const MODELS = {
  // Our library's LLM paths (tier 3 + retrieval select/answer).
  ours: 'claude-opus-4-8',
  // The tuned baseline: cheap per-chunk contextualizer + embeddings + answerer.
  baselineContext: 'claude-haiku-4-5',
  baselineEmbed: 'text-embedding-3-small',
  answer: 'claude-opus-4-8', // both systems answer with the same model, for fairness
  grader: 'claude-opus-4-8',
};

export const FIXTURES = ['boe', 'brk', 'gpt4', 'attn', 'bert'];
