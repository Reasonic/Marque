# Vectorless RAG

Structure-first document indexing without a vector database.

## Background

Embeddings and vector stores add cost and infrastructure to retrieval.

### Prior Work

PageIndex reconstructs a document's structure with hundreds of LLM calls,
reading none of the structure the file already contains.

## Approach

We read the embedded outline first, then typography, then an LLM only for
what is genuinely ambiguous.

```bash
# this is a shell comment, not a heading
echo "do not treat me as a section"
```

## Evaluation

On the benchmark, four of five fixtures resolve at tier one with zero LLM calls.

## Conclusion

Documents already carry their structure; reading it is exact, instant, and free.
