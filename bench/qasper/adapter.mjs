/**
 * QASPER → Marque adapter. QASPER papers arrive already parsed into sections and
 * paragraphs (not PDF), so this is a *non-PDF* extraction adapter: it maps that
 * structure into the exact shape `index()` would have produced, then retrieval
 * runs unchanged. Structure is read, never reconstructed — the thesis, on prose.
 *
 * Each `full_text` entry (a section or a `:::`-nested subsection) becomes one
 * structural unit; depth comes from the `:::` nesting. Section boundaries are
 * character-exact because we build `fullText` from the paragraphs ourselves, so
 * locateSections' fallback (start of the unit's own "page") is the true offset.
 */
import { locateSections, buildTree } from '../../src/structure/sections.mjs';

const SEP = '\n\n';

/**
 * @returns {{ structure, _doc, sections }} — `sections[i]` carries each unit's
 *   char span and its paragraphs' spans, for mapping gold evidence back to a unit.
 */
export function qasperDoc(paper) {
  const secs = paper.full_text.filter((s) => s.paragraphs && s.paragraphs.length);
  let fullText = '';
  const pages = [];
  const entries = [];
  const sections = [];

  secs.forEach((s, i) => {
    const offset = fullText.length;
    const name = s.section_name || `Section ${i + 1}`;
    const depth = name.split(':::').length - 1;
    const paras = [];
    let body = '';
    for (const p of s.paragraphs) {
      const start = offset + body.length;
      body += p + SEP;
      paras.push({ text: p, char_start: start, char_end: start + p.length });
    }
    fullText += body;
    pages.push({ page: i + 1, text: body, offset });
    // Title is the leaf name (after the last ':::'); locateSections won't find it
    // in the body (section names aren't headings in the text), so it falls back to
    // the page offset — which is exactly where the unit starts.
    entries.push({ title: name.split(':::').pop().trim(), depth, page: i + 1, status: 'verified' });
    sections.push({ index: i, name, char_start: offset, char_end: offset + body.length, paras });
  });

  const located = locateSections(entries, pages, fullText.length);
  const structure = buildTree(located);
  const _doc = { name: paper.title || 'paper', numPages: pages.length, pages, fullText, outline: entries, lines: [] };
  return { structure, _doc, sections };
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();

/**
 * Map a gold-evidence string to the index of the section that contains it.
 * QASPER evidence is verbatim paragraph text; match on normalized text so minor
 * whitespace/punctuation differences don't miss. Returns -1 if not a text
 * paragraph (e.g. "FLOAT SELECTED" figure references).
 */
export function evidenceSection(sections, evidence) {
  const e = norm(evidence);
  if (!e || e.length < 8) return -1;
  for (const s of sections) {
    for (const p of s.paras) {
      const np = norm(p.text);
      if (np.includes(e) || e.includes(np)) return s.index;
    }
  }
  return -1;
}
