import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * PDF extraction: per-page text with global character offsets, per-line
 * typographic metadata (for heading inference), and the embedded outline.
 */

const LINE_Y_TOLERANCE = 2.5;
const MIN_ITEMS_PER_COLUMN = 15;

/**
 * Assemble page text from pdf.js items, restoring separators.
 *
 * pdf.js emits positioned runs, not words. Concatenating them directly welds
 * tokens together ("1Introduction", "NERMNLIFigure"), which breaks word-level
 * matching and degrades the text an LLM eventually reads. Separators are
 * recovered from line breaks and horizontal gaps.
 */
function needsSpace(prev, it, text) {
  const gap = it.transform[4] - (prev.transform[4] + (prev.width || 0));
  const size = Math.abs(it.transform[3]) || 10;
  return gap > size * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.str);
}

function assemblePageText(items) {
  let text = '';
  let prev = null;

  for (const it of items) {
    if (!it.str) {
      if (it.hasEOL && text && !text.endsWith('\n')) text += '\n';
      continue;
    }
    if (prev) {
      const newLine = prev.hasEOL || Math.abs(it.transform[5] - prev.transform[5]) > LINE_Y_TOLERANCE;
      if (newLine) {
        if (!text.endsWith('\n')) text += '\n';
      } else if (needsSpace(prev, it, text)) {
        text += ' ';
      }
    }
    text += it.str;
    prev = it;
  }
  return text;
}

/** Same separator recovery, within a single line. */
function joinLineParts(parts) {
  let text = '';
  for (let i = 0; i < parts.length; i++) {
    if (i && needsSpace(parts[i - 1].raw, parts[i].raw, text)) text += ' ';
    text += parts[i].str;
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Group a page's text items into lines, handling two-column layouts by reading
 * the left column fully before the right. pdf.js emits items in content-stream
 * order, which interleaves columns on many academic PDFs.
 */
function itemsToLines(items, pageWidth, page) {
  const mid = pageWidth / 2;
  const left = items.filter((i) => i.x < mid);
  const right = items.filter((i) => i.x >= mid);
  const twoColumn = left.length > MIN_ITEMS_PER_COLUMN && right.length > MIN_ITEMS_PER_COLUMN;
  const ordered = twoColumn ? [...left, ...right] : items;

  const lines = [];
  for (const it of ordered) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) < LINE_Y_TOLERANCE) {
      last.parts.push(it);
      last.y = it.y;
    } else {
      lines.push({ y: it.y, parts: [it] });
    }
  }

  return lines.map((l) => ({
    page,
    twoColumn,
    y: l.y,
    text: joinLineParts(l.parts),
    size: Math.max(...l.parts.map((p) => p.size)),
    font: l.parts[0].font,
    bold: /bold|black|semib|heavy/i.test(l.parts[0].font || ''),
  })).filter((l) => l.text);
}

async function extractOutline(doc) {
  const raw = await doc.getOutline();
  if (!raw) return [];
  const flat = [];
  const walk = async (items, depth) => {
    for (const it of items) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest)) page = (await doc.getPageIndex(dest[0])) + 1;
      } catch {
        /* unresolvable destination; dropped below */
      }
      flat.push({ title: (it.title || '').replace(/\s+/g, ' ').trim(), depth, page });
      if (it.items?.length) await walk(it.items, depth + 1);
    }
  };
  await walk(raw, 0);
  return flat.filter((e) => e.page !== null && e.title);
}

export async function extract(path, { withLines = true } = {}) {
  const data = new Uint8Array(fs.readFileSync(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const pages = [];
  const lines = [];
  let offset = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const text = assemblePageText(tc.items);
    pages.push({ page: p, text, offset });

    if (withLines) {
      const items = tc.items
        .filter((i) => i.str.trim())
        .map((i) => ({
          str: i.str,
          raw: i,
          x: i.transform[4],
          y: i.transform[5],
          size: Math.round(Math.abs(i.transform[3]) * 10) / 10,
          font: i.fontName,
        }));
      if (items.length) lines.push(...itemsToLines(items, page.getViewport({ scale: 1 }).width, p));
    }
    offset += text.length;
  }

  return {
    name: path.split('/').pop(),
    numPages: doc.numPages,
    pages,
    lines,
    fullText: pages.map((p) => p.text).join(''),
    outline: await extractOutline(doc),
  };
}

export const pageRangeText = (doc, start, end) =>
  doc.pages.slice(start - 1, end).map((p) => p.text).join('');
