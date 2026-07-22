# FinanceBench head-to-head

A controlled comparison on FinanceBench's 150-question public subset: our
structure-first retrieval vs. a **tuned** vector baseline, with the same
answerer and the same grader, so the only variable is retrieval.

```bash
node --env-file=.env bench/financebench/run.mjs --budget 150    # full 150 (GPT config, ≈ $50-95)
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
2. **Contextualize** every chunk — a cheap model (`gpt-4.1-mini`) prepends a
   sentence situating the chunk in the whole document. Its 1M-token window holds
   an entire 10-K, so no filing is truncated before the model situates its chunks
   — the baseline is never handicapped on the largest documents. The document is
   prompt-cached, so this is one cheap call per chunk, as the recipe intends.
3. Embed the contextualized chunks (`text-embedding-3-small`) and index them for
   BM25 as well.
4. Retrieve by **reciprocal-rank fusion** of the vector and BM25 rankings.
5. Answer from the fused top-k.

Both systems answer with the **same** model — the comparison isolates retrieval,
not answer generation. The answerer of record is **Claude Sonnet 5**; while the
Anthropic account is unfunded the runs use **`gpt-4o`** (all-OpenAI), a capable
answerer whose choice shifts absolute scores but not which retriever wins. A
reranker (Cohere in the original recipe) is a hook, left off by default because it
needs another provider.

### Why a GPT config

The models here are OpenAI's, and that is deliberate on two counts. The baseline
already embeds with `text-embedding-3-small`, so its vector channel was never
Anthropic's. And grading the head-to-head with a **third-party** model — not the
vendor whose Contextual Retrieval recipe *is* the baseline — removes the obvious
"the recipe's author is also the judge" objection. Provider-neutral models make
the comparison more defensible, not less; the exact ids are pinned in
[`../config.mjs`](../config.mjs) (`FINANCEBENCH_MODELS`) and overridable with
`--answer-model` / `--context-model` / `--grader-model`.

One implementation note that matters for cost: OpenAI does **not** cache the
shared document prefix automatically here (measured: 0% cache hits without a
routing key, ~99% with one), so the contextualizer sets a per-document
`promptCacheKey`. Without it the recipe would run fully uncached and cost several
times more. The meter credits each family's real cached-read discount
(`gpt-4.1` 75%, `gpt-4o` 50%), so the reported dollar figure tracks the invoice.

### Strict agreement, one grader

The headline is **strict agreement**: an independent grader (`gpt-4o`) marks an
answer correct only if it conveys the same fact or number as the gold answer — a
different number, a wrong sign, or a hedge that never commits is incorrect. The
same grader and prompt score every system, so any grader bias applies equally to
both.

## Caveats (read these before the numbers)

- **This is a single measured run, not an average.** LLM outputs are not seed-
  deterministic on these models, so re-running will move the numbers by a few
  points. The exact models are pinned in [`../config.mjs`](../config.mjs).
- **Subset by cost.** The contextual baseline makes one LLM call per chunk across
  every filing, so a full-fidelity run over all 84 documents is expensive. Runs
  are bounded by a `--budget` ceiling and **stop cleanly**, reporting how many
  questions were graded. When a run is partial, the count is stated; the three
  question types stay interleaved, so the type breakdown remains balanced.
- **The contextualization document is capped** at 250k tokens — a cost ceiling,
  not a window limit (the contextualizer's window is 1M). Real 10-Ks fall under
  it, so in practice no filing's tail is hidden from the contextualizer.
- **LLM grading is imperfect.** Every graded answer — question, gold, both
  systems' answers, and the grader's verdict and reason — is written to
  `results.json` so a skeptical reader can audit the calls.

## Results

A single measured run on the GPT config, **142 of 150 questions**. The run stopped
8 short when the OpenAI account hit its quota while indexing two large filings
(PepsiCo 2022, Pfizer 2021); those eight are excluded from *both* systems, so the
comparison stays unbiased, and eight questions cannot move a 17-point gap.

| system | strict agreement |
|---|---|
| ours (structure-first) | **26.1%**  (37/142) |
| baseline (contextual)  | **43.7%**  (62/142) |

By question type:

| type | n | ours | baseline |
|---|---|---|---|
| metrics-generated | 48 | 22.9% | 31.3% |
| domain-relevant   | 47 | 23.4% | 40.4% |
| novel-generated   | 47 | 31.9% | 59.6% |

Agreement grid: both correct 23 · **ours only 14** · baseline only 39 · neither 66.

**Structure-first loses here, and the diagnosis is precise.** These are 100–200 page
10-Ks whose answers are numbers inside financial statements. The deeper cause is a
*vocabulary* gap, not a granularity one: the FY2018 capital-expenditure figure appears
only as *"Purchases of property, plant and equipment (PP&E) $(1,577)"* — the words
"capital expenditure" never sit next to it. Lexical retrieval cannot cross a synonym;
vector search, matching meaning, can. That single gap accounts for most of the loss.

### Query expansion closes half the gap

One small LLM call that expands the query with the document's likely wording
("capex" → "purchases of property, plant and equipment") *before* lexical retrieval
lifts ours from **26% to 36%** (54/150, full run). An A/B on the same questions shows
the gain is almost entirely from expansion, not the coverage/localisation fixes that
ship alongside it:

| ours (same 117 questions) | strict agreement |
|---|---|
| no expansion | 27.4% |
| + coverage & localisation | 28.2% |
| **+ query expansion** | **35.9%** |

That roughly **halves** the distance to the vector baseline (44%), for near-zero cost
and still no vector database. What remains is the genuinely semantic tail, where
embeddings keep the edge. It is not a rout — ours also uniquely answers **14**
questions the baseline gets wrong — and the honest boundary is now the narrower one:
you do not need a vector database to *navigate* a structured document, and expansion
recovers much of the harder retrieval too.

### A second reference point: RAPTOR

The vector baseline is the *ceiling* here; RAPTOR is the closest *peer*. It is a
well-cited tree/summary RAG (Sarthi et al., ICLR 2024) that, like us, imposes
structure on a document — but *with* embeddings: it recursively clusters and
LLM-summarizes chunks into a tree, then retrieves across the summary layers.
Running it head-to-head answers the fair question — does the tree buy anything our
structure-first pass doesn't, once you also pay for a vector index?

We run the real repo — [`raptor_bridge.py`](raptor_bridge.py) drives
`github.com/parthsarthi03/raptor` as a **retrieval system only**, with the same
`gpt-4o` answerer and the same grader, so (exactly as with the baseline) retrieval
is the only variable. RAPTOR's config is stated for the record:
`text-embedding-3-small` (the same embeddings as the baseline), `gpt-4o-mini` for
cluster summaries (RAPTOR uses a cheap summariser by design), 300-token leaf chunks,
top-8 retrieval.

On the **142 questions all three systems answered**:

| system | strict agreement | vector index? |
|---|---|---|
| baseline (contextual)                 | **43.7%** (62/142) | yes |
| **ours** (structure-first + expansion) | **35.9%** (51/142) | **no** |
| RAPTOR (tree/summary)                 | **34.5%** (49/142) | yes |

**Read this as parity, not a win.** Ours is nominally ahead of RAPTOR — but 51 vs 49
is a two-question margin on a single, non-deterministic run, which is noise. The
result that matters is the *tie*: structure-first retrieval matches a tree-RAG that
embeds every chunk and summarizes it recursively, while using **no embeddings and no
vector store** — and it does so at **$3.02** of metered cost for the whole
150-question run, roughly a hundredth of an equivalent PageIndex run. Both peers still
trail the tuned vector baseline; the tables are where embeddings keep their edge.

Caveats specific to this run:
- Single run, ~2-question margin → **parity, not superiority**. Re-running moves it.
- One RAPTOR build failed — `CVSHEALTH_2022_10K`, whose Gaussian-mixture clustering
  raised *"ill-defined empirical covariance"*; its questions got no context and are
  counted against RAPTOR — a real, if narrow, robustness gap, not a scoring artefact.
- The RAPTOR config above is one reasonable choice; a differently tuned tree could
  score differently. It is pinned in the bridge so the run is reproducible.

Reproduce (RAPTOR repo + venv are fetched locally, never committed):
```bash
node --env-file=.env bench/financebench/raptor_run.mjs --budget 40
```

This is the boundary the benchmark exists to draw. The library's claim is that you do
not need a vector database to *navigate* a structured document, and the
structure-extraction numbers elsewhere in this repo hold. FinanceBench tests a harder
downstream task — financial question-answering over tables — and there structure-first
is not a substitute for embeddings. Both are true; this is where the "vectorless"
claim runs out, stated plainly rather than hidden.

**Caveats specific to this run:**
- The answerer of record is Claude Sonnet 5; this run used `gpt-4o` (the Anthropic
  account was unfunded). A stronger answerer lifts *both* systems and would sharpen,
  not close, the retrieval gap.
- Metered cost was **$143.5** for the run reported here — that spans the initial pass
  plus two resumes that re-indexed some filings after mid-run provider failures (a
  content-filter false positive, a TPM cap). A clean single pass is ~$115–125,
  dominated by the baseline's one-LLM-call-per-chunk contextualization.

**Reproduce:**

```bash
node --env-file=.env bench/financebench/run.mjs --budget 150 --answer-model gpt-4o
# resume after any interruption — skips graded questions, re-spends nothing on them:
node --env-file=.env bench/financebench/run.mjs --budget 150 --answer-model gpt-4o --resume
# a giant filing can trip a provider tokens-per-minute cap; pace it with --concurrency 1
```

Every graded answer — question, gold, both systems' answers, and the grader's verdict
and reason — is in `results.json` for audit.
