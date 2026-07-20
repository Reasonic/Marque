/** Shared tokenization. Kept in one place so matching stays consistent. */

export const words = (s) => (s || '').toLowerCase().match(/[a-z0-9]+/g) || [];

/**
 * Stopwords for *title matching*, where a handful of boilerplate terms
 * ("for the year ended") otherwise dominate short titles. BM25 does not use
 * this list — inverse document frequency handles common terms properly.
 */
export const STOPWORDS = new Set([
  'the', 'of', 'a', 'an', 'to', 'for', 'and', 'in', 'on', 'as', 'at', 'is',
  'ended', 'period', 'year', 'our', 'we', 'its', 'this', 'that', 'by', 'with',
]);

export const contentWords = (s) => words(s).filter((t) => !STOPWORDS.has(t));
