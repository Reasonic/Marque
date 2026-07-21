/**
 * Token → dollar cost meter for the benchmark runs.
 *
 * The Phase 2 head-to-head spends real money (contextual-embedding preprocessing
 * is one LLM call per chunk), so every model call is metered and a hard budget
 * ceiling can halt the run before it overspends. Prices are USD per million
 * tokens, from the model cards; caching is credited when the provider reports it,
 * otherwise input is billed at full rate (a deliberate over-estimate — the guard
 * should trip early, not late).
 */
const PRICES = {
  // model id            input,  output   ($ / 1M tokens)
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'text-embedding-3-small': [0.02, 0],
  'text-embedding-3-large': [0.13, 0],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
};

const state = {
  usd: 0,
  calls: 0,
  byModel: {}, // id -> { calls, in, out, cachedIn, usd }
  budget: Infinity,
};

/**
 * price(id) → [inPerM, outPerM]; unknown models cost 0 but are still counted.
 * The longest (most specific) matching key wins, so `gpt-4o-mini` is not
 * mis-priced as `gpt-4o` (its own name contains the shorter key as a substring).
 */
function price(id) {
  const keys = Object.keys(PRICES).filter((k) => id?.includes(k)).sort((a, b) => b.length - a.length);
  return keys.length ? PRICES[keys[0]] : [0, 0];
}

export function setBudget(usd) { state.budget = usd; }

/**
 * Record one call's usage and return the running total. Both the Anthropic and
 * OpenAI adapters report the cache split under `usage.inputTokenDetails`
 * ({noCacheTokens, cacheReadTokens, cacheWriteTokens}) — verified empirically.
 * A cache write costs 1.25× base input (Anthropic only; OpenAI reports none).
 * The cache-read discount differs by provider: Anthropic reads at 0.1× base,
 * OpenAI at 0.5×. Calls without that breakdown (e.g. embeddings) bill all input
 * at base rate.
 */
export function record(modelId, usage = {}) {
  const [inP, outP] = price(modelId);
  const det = usage.inputTokenDetails || {};
  const inTok = usage.inputTokens || 0;
  const outTok = usage.outputTokens || 0;
  const cacheRead = det.cacheReadTokens || 0;
  const cacheWrite = det.cacheWriteTokens || 0;
  const fresh = det.noCacheTokens ?? Math.max(inTok - cacheRead - cacheWrite, 0);
  // Cache-read discount by family: Anthropic 90% off, gpt-4.1 75% off, gpt-4o 50% off.
  const readMult = /claude/i.test(modelId) ? 0.1 : /gpt-4\.1/i.test(modelId) ? 0.25 : 0.5;

  const usd = (fresh * inP + cacheWrite * inP * 1.25 + cacheRead * inP * readMult + outTok * outP) / 1e6;
  state.usd += usd;
  state.calls++;
  const m = state.byModel[modelId] ||= { calls: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  m.calls++; m.in += inTok; m.out += outTok; m.cacheRead += cacheRead; m.cacheWrite += cacheWrite; m.usd += usd;
  return state.usd;
}

/** Throw if the budget is spent — callers check this between units of work. */
export function guard() {
  if (state.usd > state.budget) {
    const e = new Error(`budget exceeded: $${state.usd.toFixed(2)} > $${state.budget.toFixed(2)} ceiling`);
    e.code = 'BUDGET_EXCEEDED';
    throw e;
  }
}

export const spent = () => state.usd;

export function summary() {
  const lines = [`total: $${state.usd.toFixed(3)} over ${state.calls} calls`];
  for (const [id, m] of Object.entries(state.byModel)) {
    lines.push(`  ${id.padEnd(24)} ${String(m.calls).padStart(5)} calls  `
      + `in=${m.in} out=${m.out} cacheR=${m.cacheRead} cacheW=${m.cacheWrite}  $${m.usd.toFixed(3)}`);
  }
  return lines.join('\n');
}

export function reset() {
  state.usd = 0; state.calls = 0; state.byModel = {}; state.budget = Infinity;
}
