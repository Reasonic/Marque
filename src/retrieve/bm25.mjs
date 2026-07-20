/**
 * BM25 over document sections. No embeddings, no vector store, no index files —
 * the whole thing is built in memory in milliseconds.
 *
 * This is the prefilter that keeps the LLM's job small: rank ~200 sections
 * locally, hand it ~10. Lexical search is not a fallback here, it is the
 * substrate — removing the equivalent BM25 index from LocAgent cost 13.1 points
 * of localisation accuracy, more than removing its graph traversal.
 */
import { words } from '../text.mjs';

const K1 = 1.5;
const B = 0.75;
const TITLE_BOOST = 3;

/**
 * @param {Array<{title: string, text: string}>} docs
 */
export function buildIndex(docs) {
  const postings = new Map(); // term -> Map(docIndex -> frequency)
  const lengths = new Array(docs.length).fill(0);

  docs.forEach((doc, i) => {
    const counts = new Map();
    const add = (tokens, weight) => {
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + weight);
    };
    add(words(doc.title), TITLE_BOOST);
    add(words(doc.text), 1);

    let len = 0;
    for (const [term, freq] of counts) {
      if (!postings.has(term)) postings.set(term, new Map());
      postings.get(term).set(i, freq);
      len += freq;
    }
    lengths[i] = len;
  });

  const total = lengths.reduce((a, b) => a + b, 0);
  return { postings, lengths, count: docs.length, avgLength: total / Math.max(docs.length, 1) };
}

export function search(index, query, limit = 10) {
  const { postings, lengths, count, avgLength } = index;
  const scores = new Map();

  for (const term of new Set(words(query))) {
    const posting = postings.get(term);
    if (!posting) continue;

    const idf = Math.log(1 + (count - posting.size + 0.5) / (posting.size + 0.5));
    for (const [doc, freq] of posting) {
      const norm = freq * (K1 + 1) / (freq + K1 * (1 - B + B * (lengths[doc] / avgLength)));
      scores.set(doc, (scores.get(doc) || 0) + idf * norm);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([doc, score]) => ({ doc, score }));
}
