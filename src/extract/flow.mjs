/**
 * Assemble the normalized document from a flat list of `{title, depth, body}`
 * sections — shared by the structured-text extractors (HTML, DOCX, …), which all
 * arrive at the same intermediate shape once their markup is parsed.
 *
 * Each section becomes one synthetic "page" whose text starts with the section's
 * own title, so title-on-its-page verification passes and locateSections finds
 * the exact offset — exactly as on a real paginated document.
 */
export function docFromSections(name, sections) {
  let fullText = '';
  const pages = [];
  const outline = [];
  sections.forEach((s, i) => {
    const offset = fullText.length;
    const text = `${s.title}\n${s.body}\n`;
    fullText += text;
    pages.push({ page: i + 1, offset, text });
    outline.push({ title: s.title, depth: s.depth, page: i + 1 });
  });
  return { name, numPages: pages.length, pages, lines: [], fullText, outline };
}

/**
 * Fold a lead block that precedes the first heading into the first section (it is
 * the document's intro, not a section of its own); with no headings at all it
 * becomes the sole section, titled by `fallbackTitle`.
 */
export function foldPreamble(sections, pre, fallbackTitle) {
  if (pre.length <= 40) return sections;
  if (sections.length) sections[0].body = `${pre}\n${sections[0].body}`;
  else sections.push({ depth: 0, title: fallbackTitle, body: pre });
  return sections;
}
