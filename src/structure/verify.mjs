/**
 * Local structure verification. Replaces PageIndex's `verify_toc`, which spends
 * one LLM call per section to do what is fundamentally fuzzy string matching.
 *
 * Critically, a mismatch is reported as UNVERIFIED, never as WRONG. Outline
 * titles are semantic labels, not verbatim headings — the Berkshire outline
 * says "Chairman's Letter" where the page reads "To the Shareholders of
 * Berkshire Hathaway Inc.", yet the page number is correct. PageIndex treats
 * that as an error and "repairs" a correct index.
 */

import { contentWords as tokenize } from '../text.mjs';

export const VERIFIED = 'verified';
export const PARTIAL = 'partial';
export const UNVERIFIED = 'unverified';

/**
 * Fraction of a title's content words that appear on its claimed start page.
 * Set-based rather than substring-based: substring matching fails on trivial
 * wording differences (107/109 vs 79/109 on the same corpus).
 */
export function verifyEntry(entry, pages) {
  const titleTokens = tokenize(entry.title);
  if (!titleTokens.length) return { status: UNVERIFIED, coverage: 0 };

  const page = pages[entry.page - 1];
  if (!page) return { status: UNVERIFIED, coverage: 0 };

  const pageTokens = new Set(tokenize(page.text));
  const hits = titleTokens.filter((t) => pageTokens.has(t)).length;
  const coverage = hits / titleTokens.length;

  const status = coverage >= 0.8 ? VERIFIED : coverage >= 0.5 ? PARTIAL : UNVERIFIED;
  return { status, coverage };
}

export function verifyAll(entries, pages) {
  const results = entries.map((e) => ({ ...e, ...verifyEntry(e, pages) }));
  const tally = { [VERIFIED]: 0, [PARTIAL]: 0, [UNVERIFIED]: 0 };
  for (const r of results) tally[r.status]++;
  return { entries: results, tally, needsReview: results.filter((r) => r.status === UNVERIFIED) };
}
