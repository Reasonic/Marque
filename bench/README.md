# Query-path token instrumentation

Measures what it costs, in input tokens, to answer **one question** about a PDF —
comparing PageIndex's retrieval shape against progressive disclosure.

```bash
node bench/query-cost.mjs bench/fixtures/*.pdf
```

## What this measures — and what it does not

This measures **payload size**, which is deterministic and needs no API key.
It is *not* an end-to-end measurement of PageIndex; nothing here calls an LLM.

The PageIndex side is modelled directly from its source:

| Behaviour | Source |
|---|---|
| `get_document_structure()` returns the whole tree, stripping only `text` — `summary` is kept | `pageindex/retrieve.py` |
| Node summaries are on by default | `pageindex/config.yaml` (`if_add_node_summary: "yes"`) |
| `get_page_content(pages="5-7")` returns whole pages | `pageindex/retrieve.py` |
| Driven as an agent loop, so every prior tool result is re-sent each turn | `examples/agentic_vectorless_rag_demo.py` |
| Nodes split when they exceed **both** 10 pages and 20k tokens | `pageindex/config.yaml`, `page_index.py` |

Two modelled quantities:

- **Summary length.** PageIndex's `generate_node_summary` prompt sets no length
  limit, so the true value is unknown. Swept at 40/80/120 tokens.
- **Child-node count after splitting.** LLM-determined in the original;
  `ceil(pages/10)` here, a deliberate under-estimate.

Both choices, plus the omission of output tokens and reasoning traces, bias the
result **in PageIndex's favour**. Treat the numbers as a conservative floor:
this model produces 16k–34k billed tokens/query, whereas MCompassRAG
independently measured PageIndex at ~54k.

## Results

80-token summaries, 3 sections retrieved. Section spans come from the indexer
itself, so the benchmark and the library cannot drift apart.

| Document | Pages | Nodes | PageIndex | Progressive | Reduction |
|---|---|---|---|---|---|
| Attention | 15 | 22 | 19,072 | 2,252 | **8.5×** |
| BERT | 16 | 14 | 22,016 | 4,067 | **5.4×** |
| Bank of England AR | 220 | 38 | 30,144 | 5,426 | **5.6×** |
| Berkshire AR | 152 | 61 | 50,906 | 9,680 | **5.3×** |
| GPT-4 report | 100 | 33 | 26,264 | 2,583 | **10.2×** |

Two independent effects, worth separating:

**1. Agent-loop accumulation dominates.** Re-sending the full tree and every
fetched page on each turn is the single largest term. Two bounded calls remove
it. This effect grows with summary length — at 120-token summaries the Bank of
England case reaches 7.3×.

**2. Char-exact sections beat page ranges, but less than expected.** Median
**1.0×–2.6×** depending on the document, not the 3–5× first assumed. The saving
exists only where a section is smaller than the pages containing it, so it is
large for dense multi-section pages (papers: 2.2×–2.6× median) and near zero for
sections spanning many pages (Berkshire: 1.01× median). Individual small
subsections buried in large pages reach several hundred ×, but the median is the
honest headline.

## Side finding: heading localisation

| Document | Headings located to an exact character offset |
|---|---|
| GPT-4 report | 26/26 |
| Attention | 22/22 |
| BERT | 14/14 |
| Bank of England AR | 29/38 |
| Berkshire AR | 15/21 |

Papers resolve perfectly; financial reports do not, because outline titles there
are semantic labels rather than verbatim headings — the Berkshire outline says
`Chairman's Letter` where page 5 reads *"To the Shareholders of Berkshire
Hathaway Inc."*. The page number is still correct.

This is why section boundaries must fall back to page granularity on a miss, and
why a title/page mismatch must be treated as **unknown**, never as **wrong**.
PageIndex's `verify_toc` conflates the two and can "repair" a correct index.
