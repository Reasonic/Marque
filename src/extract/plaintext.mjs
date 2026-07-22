import fs from 'node:fs';

/**
 * Plain-text extraction — the one non-PDF format that is NOT exact-and-free.
 * A .txt file carries no markup, so structure is *inferred* from conventions, not
 * read: this is a heuristic, best-effort pass, closer to PDF typography than to
 * Markdown/HTML/DOCX/EPUB. Biased toward under-detection (invariant: never guess) —
 * a missed heading leaves text reachable via gap coverage, a hallucinated one
 * corrupts the index.
 *
 * Signals, all conservative:
 *   - a Setext underline (a line of === or ---) beneath a short line
 *   - a section number opening the line ("2.1 Method"), short and title-cased
 *   - a Chapter/Section/Part/Appendix keyword
 *   - an ALL-CAPS short line set off by a blank line above
 */
const RULE = /^([=\-])\1{2,}\s*$/;                    // === (depth 0) or --- (depth 1)
const NUMBERED = /^(\d+(?:\.\d+)*)\.?\s+([A-Z].{0,78})$/;
const KEYWORD = /^((?:chapter|section|part|appendix)\b.{0,60})$/i;
const ALLCAPS = /^[A-Z][A-Z0-9 &,'()./-]{2,58}$/;

export async function extractText(path) {
  const fullText = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const lines = fullText.split('\n');
  const offset = [];
  let o = 0;
  for (const l of lines) { offset.push(o); o += l.length + 1; }
  const blank = (i) => i < 0 || i >= lines.length || lines[i].trim() === '';

  const heads = [];
  const add = (title, depth, i) => heads.push({ title, depth, page: heads.length + 1, offset: offset[i], signal: 'text' });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length > 80) continue;

    const under = i + 1 < lines.length && RULE.exec(lines[i + 1].trim());
    if (under && /[A-Za-z]/.test(line)) { add(line, under[1] === '=' ? 0 : 1, i); continue; }

    const num = NUMBERED.exec(line);
    if (num && num[2].split(/\s+/).length <= 8 && !/[.!?]$/.test(num[2])) {
      add(line, num[1].split('.').length - 1, i); continue;
    }
    if (KEYWORD.test(line)) { add(line, 0, i); continue; }
    if (blank(i - 1) && ALLCAPS.test(line) && !/[a-z]/.test(line)) add(line, 0, i);
  }

  // Sections span heading→next heading; each becomes its own "page" so the heading
  // sits at the top of its page and verification/offset-location work unchanged.
  const pages = heads.map((h, i) => ({
    page: i + 1,
    offset: h.offset,
    text: fullText.slice(h.offset, i + 1 < heads.length ? heads[i + 1].offset : fullText.length),
  }));
  const outline = heads.map((h) => ({ title: h.title, depth: h.depth, page: h.page, signal: h.signal }));

  return { name: path.split('/').pop(), numPages: pages.length, pages, lines: [], fullText, outline };
}
