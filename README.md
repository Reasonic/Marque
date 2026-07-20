# vectorless-rag

Structure-first document indexing. No vector database, no embeddings, no chunking.

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
| GPT-4 tech report | 100 | outline | 26 | 26/26 | 26/26 | 448 ms |
| Attention paper | 15 | outline | 22 | 22/22 | 22/22 | 259 ms |
| BERT paper | 16 | **headings** | 14 | 14/14 | 14/14 | 194 ms |

BERT has no embedded outline, so tier 2 handles it — and recovers the true
structure exactly: Abstract, sections 1–6, References, and appendices A/B/C, all
on the correct pages, with no LLM involved.

For comparison, PageIndex spends roughly 200–250 LLM calls and $0.97–$6.12 to
reconstruct this same information for a document of this size.

## Verification

Outline titles are *labels*, not necessarily the text printed on the page. The
Berkshire outline says `Chairman's Letter`; page 5 reads *"To the Shareholders of
Berkshire Hathaway Inc."*. The page number is correct — only the wording differs.

So verification reports three states, and none of them is "wrong":

- **verified** — ≥80% of the title's content words appear on its start page
- **partial** — 50–80%
- **unverified** — below 50%; needs tier-3 adjudication

Across the four outline-tier documents, 104 of 107 sections verify locally.
PageIndex spends one LLM call per section on this, and treats a mismatch as an
error to be "repaired" — which can corrupt a correct index.

## Tier 3

Runs only when tiers 1–2 leave something unresolved. On the five fixtures it is
invoked for **3 entries out of 121** — PageIndex, by contrast, runs an LLM pass
over every section unconditionally.

Two jobs: **`adjudicate()`** resolves entries local verification could not
confirm; **`inferStructure()`** recovers headings when a document declares none.

Three rules separate it from PageIndex's equivalent:

1. **Batched.** PageIndex spends one call per section on verification and another
   per repair. Here many entries share one call, bounded by tokens — all three
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
const result = await index('report.pdf', {
  llm: { json: async (prompt) => /* parsed JSON */ },
});
```

Without `llm`, tier 3 is skipped and unresolved entries stay marked
`unverified` — a truthful state, not a failure.

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
| Attention | 19,072 | 2,252 | **8.5×** |
| BERT | 22,016 | 4,067 | **5.4×** |
| Bank of England AR | 30,144 | 5,426 | **5.6×** |
| Berkshire AR | 50,906 | 9,680 | **5.3×** |
| GPT-4 report | 26,264 | 2,583 | **10.2×** |

Most of the saving comes from replacing an agent loop — which re-sends the whole
tree and every fetched page on each turn — with two bounded calls. Character-exact
section addressing contributes a further 1.0×–2.6× (median), depending on how
much smaller sections are than the pages containing them.

## Known gaps

- **No LLM path has been run against a live provider.** Tier 3 is covered by 10
  tests using deterministic mocks, which exercise batching, merging, window
  filtering and the never-guess guards — but no real model has been called.
  Retrieval's `select`/`answer` hooks are not covered even by mocks.
- `inferStructure()` has never been run on a document that actually needs it;
  all five fixtures resolve at tier 1 or 2.
- The final section absorbs all trailing content, because nothing follows it in
  the outline. In the Attention paper "Conclusion" spans p10–15, pulling in the
  references.
- Multi-line headings are split into separate sections (BERT's three-line
  appendix title becomes three entries).
- Scanned PDFs with no text layer are not handled; they need OCR.
- The query-cost benchmark models payload size and calls no LLM. It has not been
  validated against an instrumented end-to-end PageIndex run.
- Fixture PDFs are committed for reproducibility; they should be fetched by
  script instead.

## License

MIT
