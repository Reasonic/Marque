/**
 * The tuned baseline — a *fair* control, not a strawman.
 *
 * Anthropic's Contextual Retrieval recipe, implemented end to end so the
 * head-to-head is against the best standard vector stack, not a naive one:
 *
 *   1. Chunk the document (token-bounded, overlapping).
 *   2. Contextualize each chunk — a cheap LLM prepends a sentence situating the
 *      chunk in the whole document (the whole doc is prompt-cached, so this is
 *      one cheap call per chunk, not one expensive one).
 *   3. Embed the contextualized chunks (OpenAI) and index them for BM25 too.
 *   4. Retrieve by reciprocal-rank fusion of the vector and BM25 rankings
 *      (optional reranker hook — Cohere in the original recipe; off by default
 *      here since it needs another provider key).
 *   5. Answer from the fused top-k.
 *
 * This lives in bench/, never src/: the library stays vectorless; the benchmark
 * ships an embedding path precisely so "here is where we lose" is measurable.
 * Every model call is metered (see ./meter.mjs) so a run cannot silently
 * overspend.
 */
import { generateText, embed, embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { buildIndex as bm25Build, search as bm25Search } from '../src/retrieve/bm25.mjs';
import { countTokens } from '../src/retrieve/payload.mjs';
import { record, guard } from './meter.mjs';

const DEFAULTS = {
  chunkTokens: 1500,
  chunkOverlap: 150,
  contextModel: 'claude-haiku-4-5', // cheap, per-chunk — as the recipe intends
  embedModel: 'text-embedding-3-small',
  answerModel: 'claude-opus-4-8',
  maxContextTokens: 150000, // cap the doc shown to the contextualizer (fits Haiku's window; some 10-Ks exceed 200k)
  topK: 5,          // chunks handed to the answerer
  poolVector: 20,   // candidates from each channel before fusion
  rrfK: 60,         // reciprocal-rank-fusion constant
  concurrency: 8,
};

const openai = createOpenAI();
const anthropic = createAnthropic();

/** Bounded-concurrency map — keeps provider calls under the rate limit. */
async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

/**
 * Split text into overlapping, token-bounded chunks. Robust to filings that
 * arrive with no blank-line paragraphs (PDF extraction joins lines with single
 * newlines): segment on blank lines, then lines, then sentences, and hard-split
 * any segment that still exceeds the budget, so no chunk can blow the embedding
 * model's per-input token limit.
 */
export function chunkText(text, { chunkTokens = DEFAULTS.chunkTokens, chunkOverlap = DEFAULTS.chunkOverlap } = {}) {
  // Break the text into segments that are each <= chunkTokens.
  const segments = [];
  const pushBounded = (s) => {
    if (!s.trim()) return;
    if (countTokens(s) <= chunkTokens) { segments.push(s); return; }
    // too big: try finer seams, then a proportional hard slice as a last resort.
    const finer = s.includes('\n') ? s.split('\n') : (s.match(/[^.!?]+[.!?]+|\S+\s*/g) || [s]);
    let buf = '';
    for (const part of finer) {
      if (buf && countTokens(buf + part) > chunkTokens) { segments.push(buf); buf = ''; }
      buf += part;
      while (countTokens(buf) > chunkTokens) {
        const cut = Math.max(1, Math.floor(buf.length * chunkTokens / countTokens(buf)));
        segments.push(buf.slice(0, cut));
        buf = buf.slice(cut);
      }
    }
    if (buf.trim()) segments.push(buf);
  };
  for (const para of text.split(/\n\s*\n/)) pushBounded(para);

  // Greedily pack segments to ~chunkTokens, carrying a token-bounded overlap.
  const chunks = [];
  let buf = [];
  let bufTok = 0;
  const flush = () => {
    if (!buf.length) return;
    chunks.push(buf.join('\n'));
    let carry = [];
    let t = 0;
    for (let j = buf.length - 1; j >= 0 && t < chunkOverlap; j--) { carry.unshift(buf[j]); t += countTokens(buf[j]); }
    buf = carry; bufTok = t;
  };
  for (const seg of segments) {
    const t = countTokens(seg);
    if (bufTok && bufTok + t > chunkTokens) flush();
    buf.push(seg); bufTok += t;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

const CONTEXT_PROMPT = (chunk) => `Here is a chunk we want to situate within the whole document:
<chunk>
${chunk}
</chunk>
Give a short, succinct context (one or two sentences) to situate this chunk within the overall document, to improve search retrieval of the chunk. Answer only with the context and nothing else.`;

/** One contextualization call; the document is prompt-cached across chunks. */
async function contextualize(docText, chunk, cfg) {
  const res = await generateText({
    model: anthropic(cfg.contextModel),
    maxOutputTokens: 150,
    maxRetries: 3,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `<document>\n${docText}\n</document>`, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
        { type: 'text', text: CONTEXT_PROMPT(chunk) },
      ],
    }],
  });
  record(cfg.contextModel, res.usage);
  return res.text.trim();
}

/**
 * Build the contextual index for one document. Expensive (one LLM call per
 * chunk); do it once per document and reuse across that document's questions.
 * @returns {{items: Array<{chunk,context,text,embedding}>, bm25}}
 */
export async function buildIndex(docText, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const chunks = chunkText(docText, cfg);

  // The whole document situates each chunk, but a large 10-K can exceed the
  // contextualizer's context window; cap it (proportional char slice) so the
  // call fits. Do it once so the cached prefix is identical across chunks.
  let ctxDoc = docText;
  if (countTokens(docText) > cfg.maxContextTokens) {
    ctxDoc = docText.slice(0, Math.floor(docText.length * cfg.maxContextTokens / countTokens(docText)));
  }

  // Prime the prompt cache with the first call, then fan out. Firing all the
  // calls concurrently would race before the cache is written, so each would
  // miss and pay a full-document write — the dominant cost if it happens.
  const contexts = new Array(chunks.length);
  if (chunks.length) { guard(); contexts[0] = await contextualize(ctxDoc, chunks[0], cfg); }
  await mapPool(chunks.slice(1).map((c, i) => [c, i + 1]), cfg.concurrency, async ([chunk, idx]) => {
    guard();
    contexts[idx] = await contextualize(ctxDoc, chunk, cfg);
  });

  // Embed the contextualized chunk (context + chunk), as the recipe does.
  const texts = chunks.map((chunk, i) => `${contexts[i]}\n\n${chunk}`);
  const embeddings = [];
  for (let i = 0; i < texts.length; i += 64) {
    guard();
    const res = await embedMany({ model: openai.embedding(cfg.embedModel), values: texts.slice(i, i + 64) });
    record(cfg.embedModel, { inputTokens: res.usage?.tokens || 0 });
    embeddings.push(...res.embeddings);
  }

  const items = chunks.map((chunk, i) => ({ chunk, context: contexts[i], text: texts[i], embedding: embeddings[i] }));
  const bm25 = bm25Build(items.map((it) => ({ title: '', text: it.text })));
  return { items, bm25, cfg };
}

const cosine = (a, b) => {
  let d = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/** Reciprocal-rank fusion of the vector and BM25 rankings. */
function rrf(vectorRanks, bm25Ranks, k) {
  const score = new Map();
  vectorRanks.forEach((idx, rank) => score.set(idx, (score.get(idx) || 0) + 1 / (k + rank)));
  bm25Ranks.forEach((idx, rank) => score.set(idx, (score.get(idx) || 0) + 1 / (k + rank)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([idx]) => idx);
}

/** Retrieve the fused top-k chunks for a question. One embedding call. */
export async function retrieve(index, question, opts = {}) {
  const cfg = { ...index.cfg, ...opts };
  guard();
  const q = await embed({ model: openai.embedding(cfg.embedModel), value: question });
  record(cfg.embedModel, { inputTokens: q.usage?.tokens || 0 });

  const sims = index.items.map((it, i) => [i, cosine(q.embedding, it.embedding)]);
  const vectorRanks = sims.sort((a, b) => b[1] - a[1]).slice(0, cfg.poolVector).map(([i]) => i);
  const bm25Ranks = bm25Search(index.bm25, question, cfg.poolVector).map((r) => r.doc);

  const fused = rrf(vectorRanks, bm25Ranks, cfg.rrfK).slice(0, cfg.topK);
  return fused.map((i) => index.items[i]);
}

const ANSWER_PROMPT = `You are a financial analyst answering a question about a company's filing, using only the excerpts provided.
Answer directly and concisely. For a numeric question, give the number with its unit. If the excerpts do not contain the answer, say so.`;

/** Answer a question from retrieved chunks. */
export async function answer(chunks, question, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const context = chunks.map((c, i) => `[${i + 1}] ${c.chunk}`).join('\n\n---\n\n');
  guard();
  const res = await generateText({
    model: anthropic(cfg.answerModel),
    maxOutputTokens: 1024,
    maxRetries: 3,
    prompt: `${ANSWER_PROMPT}\n\nExcerpts:\n${context}\n\nQuestion: ${question}`,
  });
  record(cfg.answerModel, res.usage);
  return res.text.trim();
}

export const DEFAULTS_EXPORT = DEFAULTS;
