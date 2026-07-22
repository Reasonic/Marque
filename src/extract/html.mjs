import fs from 'node:fs';
import { docFromSections, foldPreamble } from './flow.mjs';

/**
 * HTML extraction. Structure is explicit in the markup — `<h1>`–`<h6>` are the
 * section boundaries and their depth — so, like Markdown, HTML resolves at tier 1
 * with no LLM and no typography inference.
 *
 * The document is split on heading tags into (heading, body) segments; each
 * segment's markup is stripped to text and becomes one section. Building the text
 * from the segments sidesteps any raw-offset bookkeeping, and prepending each
 * heading to its own section keeps title-on-its-page verification working.
 *
 * Zero-dependency and deliberately simple: it targets well-formed article/content
 * HTML, not arbitrary application markup. Malformed nesting degrades to fewer
 * sections rather than failing.
 */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, ' '))
  .replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Parse an HTML/XHTML string into `{title, depth, body}` sections. Exposed so the
 * EPUB extractor — whose chapters are XHTML inside a ZIP — reuses it unchanged.
 * `fallbackTitle` names the lead section when the markup has no <title>.
 */
export function htmlToSections(raw, fallbackTitle = 'Document') {
  const html = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const docTitle = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '') || fallbackTitle;

  // Split on heading tags, keeping them (capturing group), then fold each body
  // into the heading that precedes it.
  const parts = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/i);
  const segments = [];
  let preamble = '';
  for (const part of parts) {
    const h = /^<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>$/i.exec(part);
    if (h) segments.push({ depth: Number(h[1]) - 1, title: stripTags(h[2]) || 'Section', body: '' });
    else if (segments.length) segments[segments.length - 1].body += part;
    else preamble += part;
  }

  const sections = segments.map((s) => ({ depth: s.depth, title: s.title, body: stripTags(s.body) }));
  return foldPreamble(sections, stripTags(preamble), docTitle);
}

export async function extractHtml(path) {
  const name = path.split('/').pop();
  return docFromSections(name, htmlToSections(fs.readFileSync(path, 'utf8'), name));
}
