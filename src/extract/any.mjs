/**
 * Format dispatch for extraction. `index()` calls this; the tiers, verification
 * and retrieval below it are format-agnostic — each format only has to produce the
 * normalized document `{name, numPages, pages, lines, fullText, outline}`.
 *
 * PDF is the hard case (structure hidden in an outline or typography); Markdown and
 * other structured-text formats state their structure outright, so they resolve at
 * tier 1 for free. New formats slot in here as one more extractor.
 */
import { extract as extractPdf } from './pdf.mjs';
import { extractMarkdown } from './markdown.mjs';
import { extractHtml } from './html.mjs';

const extractorFor = {
  md: extractMarkdown,
  markdown: extractMarkdown,
  html: extractHtml,
  htm: extractHtml,
};

export async function extract(path, opts) {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] || '').toLowerCase();
  return (extractorFor[ext] || extractPdf)(path, opts);
}

export { pageRangeText } from './pdf.mjs';
