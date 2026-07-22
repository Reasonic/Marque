import fs from 'node:fs';
import { readZipEntry } from './zip.mjs';
import { docFromSections, foldPreamble } from './flow.mjs';

/**
 * DOCX extraction. A Word document hides no structure: every paragraph carries a
 * named style, and "Heading 1"…"Heading 6" (and "Title") ARE the outline and its
 * depth. So DOCX — a binary Office format — still resolves at tier 1 exactly, with
 * no LLM and no typography inference, the same as Markdown or HTML.
 *
 * The .docx is a ZIP; `word/document.xml` holds the body. We read paragraphs
 * (`<w:p>`), take each one's style (`<w:pStyle w:val="…">`) and its text runs
 * (`<w:t>`), and turn heading-styled paragraphs into section boundaries.
 */
const XML = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => XML[n]);

export async function extractDocx(path) {
  const xml = readZipEntry(fs.readFileSync(path), 'word/document.xml').toString('utf8');

  const sections = [];
  let pre = '';
  for (const para of xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []) {
    const style = (/<w:pStyle\s+w:val="([^"]*)"/.exec(para) || [])[1] || '';
    const text = decode((para.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim();

    const h = /^Heading(\d+)$/i.exec(style);
    if (h) sections.push({ depth: Math.max(0, Number(h[1]) - 1), title: text || 'Section', body: '' });
    else if (/^Title$/i.test(style)) sections.push({ depth: 0, title: text || 'Title', body: '' });
    else if (text) {
      if (sections.length) sections[sections.length - 1].body += (sections[sections.length - 1].body ? '\n' : '') + text;
      else pre += (pre ? '\n' : '') + text;
    }
  }

  foldPreamble(sections, pre, path.split('/').pop().replace(/\.docx$/i, ''));
  return docFromSections(path.split('/').pop(), sections);
}
