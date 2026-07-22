# QASPER — structure-first retrieval on scientific prose

The fair counterpart to the FinanceBench benchmark. FinanceBench is deliberately
our worst case (answers buried in financial tables, a lexical vocabulary gap);
QASPER is prose — scientific papers with clear section structure — where reading
structure should pay off. Reporting both is the point.

```bash
node --env-file=.env bench/qasper/run.mjs           # full dev set
node --env-file=.env bench/qasper/run.mjs --papers 20
```

QASPER ([Dasigi et al., 2021](https://arxiv.org/abs/2105.03011)) is question
answering over NLP papers. Its decisive feature for us: every answer ships **gold
evidence paragraphs**, so retrieval is scored against ground truth **with no LLM
grader in the loop** — the cleanest possible measurement.

## What is compared, and why it is fair

Both systems rank the **same units** — the paper's sections and `:::`-nested
subsections. The only variable is *how* they rank:

- **Marque** ranks by **BM25 over the structure it read** from the document. Zero
  LLM calls, zero embeddings, no vector store.
- **Vector baseline** embeds each section with `text-embedding-3-small` and ranks
  by cosine similarity to the question.

A question's **gold sections** are those containing its evidence paragraphs. We
report recall@k (is a gold section in the top k?) and MRR.

QASPER papers arrive already parsed into sections and paragraphs, not as PDF, so
[`adapter.mjs`](adapter.mjs) is a **non-PDF extraction adapter** — it maps that
structure into the exact shape `index()` produces, and retrieval runs unchanged.
Structure is read, never reconstructed; the thesis, exercised on prose.

## Results

A single deterministic run (Marque side has no randomness), **899 questions with
textual evidence across 279 papers** (28 questions whose evidence is figures/tables
only are excluded). 95% Wilson CIs.

| metric | Marque (BM25, no embeddings) | vector baseline |
|---|---|---|
| recall@1  | 28.1%  [25.3%, 31.2%] | **36.9%**  [33.8%, 40.1%] |
| recall@3  | 58.8%  [55.6%, 62.0%] | **65.9%**  [62.7%, 68.9%] |
| recall@5  | **77.9%**  [75.0%, 80.5%] | 79.6%  [76.9%, 82.1%] |
| recall@10 | 92.8%  [90.9%, 94.3%] | 95.3%  [93.7%, 96.5%] |
| MRR       | 48.3% | 55.2% |

**Read honestly:**
- **Vectors have a real edge at top-1** (recall@1, no CI overlap): semantic matching
  finds the single best section better than lexical matching. This is the genuine
  cost of going vectorless on prose QA, stated plainly.
- **By recall@5 the two are a statistical tie** (77.9% vs 79.6%, CIs overlap), and by
  recall@10 they are near-parity (both > 92%). When retrieval hands an LLM a handful
  of sections — the normal case — structure-first surfaces the evidence about as
  reliably as embeddings, **with no vector database and at $0**.

Contrast with FinanceBench, where the same lexical retrieval lost heavily on
table-bound figures: the boundary is a content one, not a structural one. Where
answers live in prose, you do not need embeddings to find them; where they live in
tables behind a synonym, you do.

## Caveats

- **Section granularity.** Both systems rank the same section units, so this is an
  apples-to-apples test of lexical vs. semantic *ranking*, holding structure fixed.
  A paragraph-chunked vector RAG (finer units) is a separate configuration; so is a
  paragraph-level Marque. The comparison here isolates the one variable.
- **Pure lexical, no query expansion.** Marque runs with zero LLM calls. On
  FinanceBench a one-call query expansion closed much of the lexical gap; the same
  hook (`llm.expand`) applies here and would most plausibly help recall@1, at the
  cost of one call per question. Left off so the headline stays a true $0 path.
- **Single run.** The Marque side is deterministic; the vector side varies only in
  the embedding service, which is effectively stable. No averaging needed.

**Cost:** ~$0.03 for the whole run — embeddings for the baseline only; the Marque
side is free.

The dataset (AllenAI's QASPER v0.3) is fetched on demand into `data/`, never
committed.
