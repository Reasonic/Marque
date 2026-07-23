# CUAD — contract clause retrieval

The counterpart to FinanceBench. FinanceBench is where structure-first loses
(figures buried in tables); contracts are the other end — numbered clauses with
headings, the kind of document structure-first is built for. CUAD (the Atticus
Contract Understanding Dataset: 510 commercial contracts, 41 clause categories,
answers highlighted as spans) lets us test that, and — because the answers are
exact spans — score retrieval **against ground truth with no LLM grader**.

```bash
node bench/cuad/run.mjs            # all 510 contracts (0 LLM, $0)
node bench/cuad/run.mjs --docs 60  # a quick slice
```

The dataset (MIT / CC BY 4.0) is fetched on demand and cached under `data/`,
never committed.

## What is measured, and why this way

Each contract's own text is indexed by Marque through the ordinary path, so the
benchmark tests Marque **detecting the contract's clause structure** and then
retrieving within it — not a pre-segmented tree.

The metric is **budget-normalised** on purpose. Marque's plaintext structure
detection is imperfect on contracts (some are a blob with no headings), and a
naive recall@k over "sections" would then be trivially 1 — one section is the
whole file. Instead we fix a reading budget *B* and ask: **within *B* tokens of
retrieved text, did the gold clause make it in?** Two methods, identical BM25 and
identical budget — the only difference is the segmentation:

- **Marque** — BM25 over the clause structure Marque read (`query()`), windowed to *B*.
- **fixed chunks** — BM25 over fixed-size overlapping chunks of the same text, to *B*.

So the number isolates exactly what reading the structure buys, against the
strongest cheap baseline for extractive retrieval. Both are **$0**. A clause is
counted retrieved when its leading 60–200 normalised characters appear in the
context — specific enough that a coincidence doesn't happen, short enough to
survive the window's cuts. Short-answer categories (party names, dates; gold < 60
chars) are too low-specificity for a substring test and are excluded.

## Sub-chunking: structure-first is not enough on its own

The first honest result was a **loss**: at 1500 tokens, plain section-level
retrieval scored **47%** against fixed chunks' **70%** — even on well-structured
contracts. The diagnosis was granularity: a clause answer (median 202 chars) is
one paragraph of a much larger section, and ranking whole sections then windowing
around the category words mislocalises, while a 1000-char chunk isolates the
clause tightly.

The fix is a general one, now in the library: a section too large to pinpoint a
short answer within also emits finer **sub-units** over its span
(`retrievalUnits`, on by default). Structure-first where sections are tight;
chunking *inside* a section too coarse to localise. This also lifted the core
retrieval eval (MRR 0.775 → 0.871) and left QASPER and the query-cost figures
unchanged — it is a real improvement, not a CUAD-specific knob.

## Result — 510 contracts, 5,080 clause questions, $0

| @ 1500 tokens | gold clause retrieved |
|---|---|
| **Marque** (structure-first + sub-chunking) | **73.5%** |
| fixed chunks (no structure) | 73.0% |

A **tie** (+0.5 pts) — parity with the strongest $0 baseline, at no cost and with
the document's clause structure still available for navigation. Per category the
two trade places (Marque leads on *No-Solicit of Customers*, *IP Ownership
Assignment*, *Notice Period to Terminate Renewal*; chunks lead on *Insurance*,
*Warranty Duration*, *Exclusivity*); neither dominates.

Read it exactly as QASPER reads: structure-first, done well, **matches** a tuned-
free lexical baseline on prose/clause retrieval. It does not beat it. Where the
answer is a figure in a financial table (FinanceBench), it loses; where the answer
is a clause, it ties. The consistent, honest through-line across all three
benchmarks is that structure-first's advantage is **cost and navigation, not
retrieval accuracy** — you drop the vector database and the indexing bill and hold
retrieval quality, rather than beating it.

## Caveats

- Marque's plaintext clause detection collapses on a substantial fraction of
  contracts (they declare few typographic headings); sub-chunking compensates by
  giving retrieval finer targets regardless. Reported granularity is the *base*
  structure (before sub-chunking), so "collapsed" reflects real structure.
- Contracts are indexed from the dataset's own text, isolating retrieval from
  PDF-extraction differences (the gold spans are offsets into that text).
- The comparison is against fixed-chunk BM25, the strongest *free* baseline; a
  tuned contextual-embedding stack would likely lead both, as on FinanceBench.
  That lane is deliberately not run here — the point is the $0 head-to-head.

Full per-category results are written to `results.json`.
