import fs from 'node:fs';
import { readZipEntry } from './zip.mjs';
import { htmlToSections } from './html.mjs';
import { docFromSections } from './flow.mjs';

/**
 * EPUB extraction. An EPUB is a ZIP of XHTML chapters plus a package file that
 * lists their reading order — so, like the other structured formats, its outline
 * is stated, not inferred: `<h1>`–`<h6>` within the chapters give the structure at
 * tier 1, no LLM. Reuses the ZIP reader (as DOCX) and the HTML section parser.
 *
 * META-INF/container.xml → the OPF package → its manifest (id → href) and spine
 * (reading order). Each spine document is parsed to sections and concatenated, so
 * a chapter with no heading still contributes one section rather than vanishing.
 */
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]+)"`, 'i').exec(tag)?.[1];
const stripXml = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export async function extractEpub(path) {
  const buf = fs.readFileSync(path);

  const container = readZipEntry(buf, 'META-INF/container.xml').toString('utf8');
  const opfPath = attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] || '', 'full-path');
  if (!opfPath) throw new Error('epub: no rootfile in META-INF/container.xml');
  const opf = readZipEntry(buf, opfPath).toString('utf8');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const bookTitle = stripXml(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] || '') || path.split('/').pop();

  const manifest = {};
  for (const item of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = attr(item, 'id'); const href = attr(item, 'href');
    if (id && href) manifest[id] = href;
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)].map((m) => attr(m[0], 'idref')).filter(Boolean);

  const sections = [];
  for (const idref of spine) {
    const href = manifest[idref];
    if (!href) continue;
    let xhtml;
    try { xhtml = readZipEntry(buf, base + decodeURIComponent(href)).toString('utf8'); } catch { continue; }
    sections.push(...htmlToSections(xhtml, bookTitle));
  }

  return docFromSections(path.split('/').pop(), sections);
}
