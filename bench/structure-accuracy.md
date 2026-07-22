# Structure-extraction accuracy

How faithfully does Marque recover a document's structure when it has to *read*
the typography — the common case, since only about 1 in 5 of the 10-Ks here ships
an embedded outline?

```bash
npm run bench:structure-accuracy
```

Deterministic, zero LLM calls, ~$0. Run it twice, get the same numbers — there is
no sampling and no variance to average away.

## Self-supervised, so nothing is hand-labelled

Every PDF that *does* ship an embedded outline is its own ground truth. For each
such document we take the outline as gold, then run tier-2 typography detection
(`detectHeadings`) **as if the outline were absent** and score what it recovered.
The detector never sees the outline — this is exactly the no-outline path it takes
in production, graded against a truth the file itself provides. No annotator, no
subjectivity, and it scales to every outline-bearing PDF in the corpus for free.

The corpus is whatever outline-bearing PDFs are present locally (fixtures via
`npm run fixtures`, plus any FinanceBench filings fetched): **18 documents, 1,772
gold headings** as measured here — academic papers (Attention, GPT-4, a Bank of
England report), diversified 10-Ks (Verizon, JPMorgan, Adobe, Lockheed, Nike),
and earnings decks.

## Results

| metric | value |
|---|---|
| **recall** (micro, heading-weighted) | **56.5%** |
| recall (macro, document-weighted) | 55.9% |
| precision\* (micro) | 30.5% |
| headings: gold / detected / matched | 1,772 / 3,282 / 1,002 |

Selected per-document recall (full table printed by the script):

| document | pages | gold | recall |
|---|--:|--:|--:|
| Attention (paper) | 15 | 22 | **100.0%** |
| GPT-4 report | 100 | 26 | 69.2% |
| Bank of England report | 220 | 38 | 94.7% |
| Nike 2023 10-K | 106 | 43 | 97.7% |
| JPMorgan 2022 10-K | 382 | 183 | 67.2% |
| Verizon 2022 10-K | 124 | 344 | 57.8% |
| Adobe 2022 10-K | 99 | 78 | 33.3% |
| PepsiCo Q1 earnings deck | 16 | 14 | 7.1% |

**Where it is strong**: documents whose headings are typographically distinct —
larger font (academic papers), numbered sections and subsections (`3.1 Attention`,
recovered even when rendered at body size), or the SEC `Item N.` / `Part` 10-K
convention. Attention's full 22-entry outline is recovered exactly.

**Where it is weak, and why**:
- *Earnings decks / slides* (PepsiCo, 7.1%) — free-form layout with no consistent
  heading typography. Genuinely hard for any structural pass.
- *Deeply nested unnumbered subsections* (Adobe's `Offerings` under `Item 1`) — a
  bold body-size line is recovered, but a subsection with no weight or size cue is
  not. These filings ship a tier-1 outline in production, so tier-2 never runs on
  them for real; the benchmark deliberately hides it to probe the fallback.

\* **Precision here is a lower bound, not the true precision.** An embedded outline
routinely *omits* real headings (the Bank of England report's 38-entry outline
covers a 220-page document with hundreds of real subheadings), so a typography hit
that isn't in the outline is usually a real heading the outline skipped, not a
false positive. Where the outline is complete — Attention — precision is 84.6%,
which is the honest figure for detection quality; the pooled 30.5% is dragged down
by coarse outlines and should be read as "at least 30.5%."

## What this is and isn't

This scores heading **detection** — did tier-2 find the heading? It does **not**
score hierarchy depth: every outline uses its own depth convention (Verizon marks
cover-page boilerplate depth-0; a paper marks its real sections depth-0), so a flat
depth comparison would measure convention mismatch, not detection. Recovering
hierarchy without numbering is a separate, weaker tier-2 capability.

It also is not the end-to-end retrieval number. Structure detection feeds
retrieval, where local verification filters what detection produced and the
labelled eval (`npm run eval`) reports 17/17 shortlist recall. This benchmark
isolates the upstream step so its quality is measured on its own terms.
