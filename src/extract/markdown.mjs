import fs from 'node:fs';

/**
 * Markdown extraction. Where a PDF hides its structure in an embedded outline or
 * in typography, Markdown states it outright: an ATX heading (`##`) is a section
 * boundary and its depth, exactly and for free. This is tier 1 for prose formats
 * — no outline table to read, no typography to infer, and never an LLM.
 *
 * The document is a flow, not paginated, so we synthesise one "page" per heading
 * section. That is only an addressing grid: each heading's title still lives at
 * the top of its own page, so verification (title-words-on-their-page) passes and
 * locateSections finds the exact offset, exactly as on a real PDF page.
 */

// ATX headings only ("# Title"). Setext (=== / --- underlines) is rarer and
// ambiguous with tables/rules; left to a later pass rather than guessed at.
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export async function extractMarkdown(path) {
  const fullText = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const lines = fullText.split('\n');

  // Locate headings by character offset, ignoring anything inside a code fence
  // (`# not a heading` in a bash block must not become a section).
  const heads = [];
  let offset = 0;
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) {
      const m = HEADING.exec(line);
      if (m) heads.push({ title: m[2].trim(), depth: m[1].length - 1, offset });
    }
    offset += line.length + 1; // + newline
  }

  // One page per heading section: [heading.offset, next heading.offset).
  const pages = heads.map((h, i) => ({
    page: i + 1,
    offset: h.offset,
    text: fullText.slice(h.offset, i + 1 < heads.length ? heads[i + 1].offset : fullText.length),
  }));

  const outline = heads.map((h, i) => ({ title: h.title, depth: h.depth, page: i + 1 }));

  return {
    name: path.split('/').pop(),
    numPages: pages.length,
    pages,
    lines: [], // structure is explicit; the typography (tier-2) path is never needed
    fullText,
    outline,
  };
}
