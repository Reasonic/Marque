# FinanceBench head-to-head

A controlled comparison on FinanceBench's 150-question public subset: our
structure-first retrieval vs. a **tuned** vector baseline, with the same
answerer and the same grader, so the only variable is retrieval.

```bash
node --env-file=.env bench/financebench/run.mjs --budget 90     # full 150
node --env-file=.env bench/financebench/run.mjs --questions 30 --budget 25   # a cheap slice
```

The dataset (Patronus AI's questions, and the SEC filings) is fetched on demand
and cached under `data/` and `pdfs/`, never committed.

## Why this benchmark is built the way it is

FinanceBench is the hard case *for us*, on purpose. These are 100–200 page 10-K
filings whose answers frequently live in tables — the setting where structure-
first retrieval is most exposed and where independent studies have found vector
RAG competitive or better on SEC filings. Reporting our result here, honestly, is
the point: "no vector DB needed for structured documents" is only credible if we
also show where the claim runs out.

### A fair baseline, not a strawman

The control is Anthropic's **Contextual Retrieval** recipe, implemented end to
end in [`../baseline.mjs`](../baseline.mjs):

1. Chunk each filing (token-bounded, overlapping).
2. **Contextualize** every chunk — a cheap model (Claude Haiku 4.5) prepends a
   sentence situating the chunk in the whole document. The document is prompt-
   cached, so this is one cheap call per chunk, as the recipe intends.
3. Embed the contextualized chunks (`text-embedding-3-small`) and index them for
   BM25 as well.
4. Retrieve by **reciprocal-rank fusion** of the vector and BM25 rankings.
5. Answer from the fused top-k.

Both systems answer with the **same** model (Claude Opus 4.8) — the comparison
isolates retrieval, not answer generation. A reranker (Cohere in the original
recipe) is a hook, left off by default because it needs another provider.

### Strict agreement, one grader

The headline is **strict agreement**: an independent grader (Claude Opus 4.8)
marks an answer correct only if it conveys the same fact or number as the gold
answer — a different number, a wrong sign, or a hedge that never commits is
incorrect. The same grader and prompt score every system, so any grader bias
applies equally to both.

## Caveats (read these before the numbers)

- **This is a single measured run, not an average.** LLM outputs are not seed-
  deterministic on these models, so re-running will move the numbers by a few
  points. The exact models are pinned in [`../config.mjs`](../config.mjs).
- **Subset by cost.** The contextual baseline makes one LLM call per chunk across
  every filing, so a full-fidelity run over all 84 documents is expensive. Runs
  are bounded by a `--budget` ceiling and **stop cleanly**, reporting how many
  questions were graded. When a run is partial, the count is stated; the three
  question types stay interleaved, so the type breakdown remains balanced.
- **The contextualization document is capped** at 150k tokens (some 10-Ks exceed
  the contextualizer's context window); the tail of the largest filings is not
  seen by the contextualizer.
- **LLM grading is imperfect.** Every graded answer — question, gold, both
  systems' answers, and the grader's verdict and reason — is written to
  `results.json` so a skeptical reader can audit the calls.

## Results

**Status: preliminary, not a headline.** The first full-run attempt exhausted
the Anthropic account's API credit after **15 of 150** questions (8 documents,
$16 metered). Fifteen questions — all from the first few alphabetical filings,
which skew metrics-heavy — are far too small and too biased to publish a number
from. This slice is directional only; a complete, funded run replaces it.

Preliminary slice (Claude Opus 4.8 answerer + grader, 15 questions):

| | strict agreement |
|---|---|
| ours (structure-first) | 1/15 |
| baseline (contextual) | 7/15 |

The direction is the one the design predicts and independent studies report:
structure-first retrieval is weakest on table-heavy financial 10-Ks, where the
answer is a number in a statement rather than prose under a heading. That is
exactly the case this benchmark exists to expose honestly — but it needs the
full 150 to make the claim, not 15.

**To complete it:** fund the Anthropic account, then

```bash
node --env-file=.env bench/financebench/run.mjs --budget 120
```

The harness checkpoints after every document and aborts cleanly on a credit or
auth error, so a re-run resumes cost-accounting from zero and reports whatever it
completes. Per-question detail (both answers, the grader's verdict and reason) is
in `results.json`.
