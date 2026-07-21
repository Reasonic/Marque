# Marque

Structure-first document indexing for RAG. No vector database, no embeddings, no chunking.

Documents already contain their own structure. Most PDFs ship an embedded
outline; most of the rest announce their headings typographically. Reading that
structure is exact, instant, and free — so this library reads it, and calls an
LLM only for what is genuinely ambiguous.

```bash
node bin/cli.mjs document.pdf
```

```
boe.pdf — 220 pages
  tier=outline  llm_calls=0  427ms
  38 sections · 29 exact offsets · 38 verified, 0 partial, 0 unverified
  ✓ Overview:                                                      p8-13
  ✓   Statement by the Chair of Court                              p8-10
  ✓   Statement by the Governor                                    p10-13
  ...
```

## How it works

Structure is recovered in tiers, cheapest first:

| Tier | Method | LLM calls |
|---|---|---|
| 1 | Embedded PDF outline — exact pages, real hierarchy | **0** |
| 2 | Typography — font size + section numbering | **0** |
| 3 | LLM inference, only for what tiers 1–2 cannot resolve | batched, as needed |

Every section is then verified locally by token-set coverage against its claimed
start page. A mismatch is recorded as **unverified**, never as **wrong** — see
[Verification](#verification) for why that distinction matters.

## Status

Implemented: tiers 1–3, local verification, and retrieval (BM25 prefilter →
optional LLM selection → budgeted answering context).

`npm test` · `npm run eval` · `npm run bench`

## Measured

Five documents, no API key, no LLM calls:

| Document | Pages | Tier | Sections | Exact offsets | Verified | Time |
|---|---|---|---|---|---|---|
| Bank of England AR | 220 | outline | 38 | 29/38 | 38/38 | 427 ms |
| Berkshire AR | 152 | outline | 21 | 15/21 | 18/21 | 699 ms |
| GPT-4 tech report | 100 | outline | 28 | 28/28 | 28/28 | 448 ms |
| Attention paper | 15 | outline | 23 | 23/23 | 23/23 | 259 ms |
| BERT paper | 16 | **headings** | 12 | 12/12 | 12/12 | 194 ms |

BERT has no embedded outline, so tier 2 handles it — and recovers the true
structure exactly: Abstract, sections 1–6, References, and appendices A/B/C, all
on the correct pages, with no LLM involved.

For comparison, PageIndex never reads the embedded outline (verifiable in its MIT
source) and reconstructs this same information from scratch — an estimated
~200–250 LLM calls for a document of this size, dollars of API cost against zero
here. (The call count is our estimate from reading the source, not a measured
figure.)

## Verification

Outline titles are *labels*, not necessarily the text printed on the page. The
Berkshire outline says `Chairman's Letter`; page 5 reads *"To the Shareholders of
Berkshire Hathaway Inc."*. The page number is correct — only the wording differs.

So verification reports three states, and none of them is "wrong":

- **verified** — ≥80% of the title's content words appear on its start page
- **partial** — 50–80%
- **unverified** — below 50%; needs tier-3 adjudication

Across the four outline-tier documents, 107 of 110 sections verify locally, with
no LLM. PageIndex verifies each section with an LLM call and, on a mismatch,
relocates the section — the behavior the *never guess* rule below exists to
avoid: a correctly-placed section whose title is merely worded differently should
not be moved.

## Tier 3

Runs only when tiers 1–2 leave something unresolved. On the five fixtures it is
invoked for **2 entries out of 122** — PageIndex, by contrast, runs an LLM pass
over every section unconditionally.

Two jobs: **`adjudicate()`** resolves entries local verification could not
confirm; **`inferStructure()`** recovers headings when a document declares none.

Three rules separate it from PageIndex's equivalent:

1. **Batched.** PageIndex spends one call per section on verification and another
   per repair. Here many entries share one call, bounded by tokens — both
   unresolved fixture entries fit in a single call.
2. **Independent windows.** PageIndex's no-outline path feeds each window the
   tree built so far, making it strictly sequential. These windows are
   independent and run concurrently.
3. **Never guess.** A relocation is accepted only when the destination page
   *independently confirms* the title. "No worse than before" is not enough — for
   an entry that verifies nowhere, any page clears that bar, which is exactly how
   a hallucinated page number silently corrupts an index. The original page came
   from the document's own outline; an LLM disagreement that local evidence
   cannot corroborate does not overturn it.

```js
import { index, createLLM } from 'marque-rag';

// Use the bundled OpenAI / Anthropic adapter (reads ANTHROPIC_API_KEY or
// OPENAI_API_KEY), or pass your own { json: async (prompt) => /* parsed JSON */ }.
const result = await index('report.pdf', { llm: createLLM() });
```

Without `llm`, tier 3 is skipped and unresolved entries stay marked
`unverified` — a truthful state, not a failure.

**Measured** — Claude Opus 4.8, reproducible with `node --env-file=.env bench/live-measure.mjs`:

| Path | Document | Result | Calls | Input tokens | Latency |
|---|---|---|---|---|---|
| `adjudicate()` | Berkshire AR | 2 unverified → 0, both resolved | 1 (batched) | 2,265 | 3.7 s |
| `inferStructure()` | no-outline fixture | `tier=llm`, 8 sections, 8/8 verified | 1 | 688 | 23 s |

Both unresolved Berkshire entries were confirmed in one batched call; a fixture
with no outline and uniform typography — nothing for tiers 1–2 to read — was
recovered entirely by tier 3, and every recovered heading verified locally.

## Retrieval

Two bounded calls, never an agent loop:

1. **BM25 prefilter** over sections — local, zero tokens, no index to keep in sync
2. **LLM selection** from titles alone — one small call, *optional*
3. **Answering** from a budgeted, citable context — one call

Step 2 is optional. With no model configured, BM25 ranking is used directly and
the whole retrieval path runs with **zero LLM calls**:

```bash
node bin/cli.mjs paper.pdf --query "How is multi-head attention computed?"
```

```
  selection=bm25  llm_calls=0  context=5416 tok
  selected:
    [0006] Multi-Head Attention                      p4-5
    [0011] Why Self-Attention                        p6-7
```

### Retrieval quality

17 labelled queries across the five fixtures (`node bench/retrieval-eval.mjs`),
BM25 only, no LLM:

| Metric | Result |
|---|---|
| Correct section in shortlist (top 12) | **17/17 (100%)** |
| Correct section selected (top 4) | 14/17 (82%) |
| Correct section ranked first | 11/17 (65%) |
| MRR over shortlist | 0.775 |

This is what justifies the two-stage design. **Lexical prefiltering never loses
the right section** — so the LLM selector always has it available — but ranking
it first is where lexical search falls down, because long sections with
incidental term matches outrank short precise ones. All three misses are that
failure: "Cybersecurity" ranked 6th behind the Chairman's Letter.

So the LLM's job is re-ranking 12 titles, not searching a document. That payload
is a few hundred tokens.

**Measured** — with the LLM selector on (Claude Opus 4.8, same 17 queries):

| Metric | BM25 only | + LLM selection |
|---|---|---|
| Correct section selected (top 4) | 14/17 (82%) | **16/17 (94%)** |

The LLM re-ranker recovers two of BM25's three misses — including "Cybersecurity",
which BM25 ranked 6th behind the Chairman's Letter. All 17 answers cited a section
id. Median input per query: ~550 selection + ~1,300 answering tokens — the
selection payload is indeed a few hundred tokens, as designed.

### Using an LLM

Pass any two functions; no provider is bundled.

```js
const res = await query(indexed, question, {
  llm: {
    select: async (prompt, k) => [/* node ids, most relevant first */],
    answer: async (prompt) => '…',
  },
});
```

Selection payloads put stable content first and the question last, so the
document outline can sit in a cached prefix across queries.

## Query cost

`bench/` measures the token cost of answering one question. See
[bench/README.md](bench/README.md) for methodology and caveats.

| Document | PageIndex | This design | Reduction |
|---|---|---|---|
| Attention | 17,632 | 2,114 | **8.3×** |
| BERT | 23,098 | 5,194 | **4.4×** |
| Bank of England AR | 30,144 | 5,426 | **5.6×** |
| Berkshire AR | 50,906 | 9,680 | **5.3×** |
| GPT-4 report | 24,122 | 2,960 | **8.1×** |

Most of the saving comes from replacing an agent loop — which re-sends the whole
tree and every fetched page on each turn — with two bounded calls. Character-exact
section addressing contributes a further 1.0×–2.6× (median), depending on how
much smaller sections are than the pages containing them.

## Where this loses

Structure-first retrieval navigates to *sections* — it does not localize a
*number inside a table*. On [FinanceBench](bench/financebench/README.md) — 150
questions over 100–200 page 10-K filings, where the answer is usually a figure in
a financial statement — a tuned vector baseline (contextual embeddings + BM25)
beats it:

| system | FinanceBench strict agreement (142/150) |
|---|---|
| this library (structure-first) | **26%** |
| tuned vector baseline | **44%** |

74% of the losses share one cause: the answer's section is never retrieved,
because a query like "capex" doesn't match the heading *"Item 8. Financial
Statements"* the way vector search matches the number's surrounding text. (It
still uniquely answers 14 questions the baseline misses.) For table-bound
financial QA, reach for embeddings — the claim here is narrower, and it holds:
you don't need a vector database to *navigate* a structured document.

## Known gaps

- Scanned PDFs with no text layer are not handled; they need OCR.
- Multi-document routing is not implemented — this indexes one document at a time.
- The query-cost benchmark (the PageIndex column above) models payload size and
  calls no LLM; it has not been validated against an instrumented end-to-end
  PageIndex run. Marque's own side is now measured live — see the Tier 3 and
  Retrieval sections above.

## License

MIT
