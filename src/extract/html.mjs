import fs from 'node:fs';

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

export async function extractHtml(path) {
  const html = fs.readFileSync(path, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');

  const docTitle = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '') || path.split('/').pop();

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

  // Content before the first heading (a lead paragraph) belongs to the first
  // section, not a phantom section of its own; with no headings at all it becomes
  // the sole section, titled by the document <title>.
  const pre = stripTags(preamble);
  if (pre.length > 40) {
    if (sections.length) sections[0].body = `${pre}\n${sections[0].body}`;
    else sections.push({ depth: 0, title: docTitle, body: pre });
  }

  let fullText = '';
  const pages = [];
  const outline = [];
  sections.forEach((s, i) => {
    const offset = fullText.length;
    const body = `${s.title}\n${s.body}\n`;
    fullText += body;
    pages.push({ page: i + 1, offset, text: body });
    outline.push({ title: s.title, depth: s.depth, page: i + 1 });
  });

  return { name: path.split('/').pop(), numPages: pages.length, pages, lines: [], fullText, outline };
}
