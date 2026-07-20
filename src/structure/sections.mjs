/**
 * Turn flat structure entries into a nested tree with character-exact spans.
 *
 * PageIndex addresses sections as whole page ranges, so reading one section
 * pulls in every page it touches. Locating the heading within its start page
 * lets retrieval return the section itself.
 */

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Find a title's character offset inside its start page.
 * Matching is done on normalized text (PDF extraction inserts erratic spacing),
 * then mapped back to a raw offset.
 */
function locate(title, page) {
  const nTitle = norm(title);
  if (!nTitle) return { charStart: page.offset, exact: false };

  const at = norm(page.text).indexOf(nTitle);
  if (at === -1) return { charStart: page.offset, exact: false };

  let seen = 0;
  for (let i = 0; i < page.text.length; i++) {
    if (/[a-z0-9]/i.test(page.text[i])) {
      if (seen === at) return { charStart: page.offset + i, exact: true };
      seen++;
    }
  }
  return { charStart: page.offset, exact: false };
}

const pageAtOffset = (pages, offset) => {
  for (let i = pages.length - 1; i >= 0; i--) if (offset >= pages[i].offset) return pages[i].page;
  return 1;
};

/**
 * Assign spans to entries already in document order.
 *
 * - `charEnd` covers the whole subtree (up to the next entry at the same or
 *   shallower depth), which is what retrieval should return for a node.
 * - `ownEnd` covers only the text before the first child, for previewing a
 *   parent without pulling its descendants.
 */
export function locateSections(entries, pages, docLength) {
  const located = [];
  let floor = 0;

  for (const e of entries) {
    const page = pages[e.page - 1];
    if (!page) continue;
    const { charStart, exact } = locate(e.title, page);
    // Structure entries are ordered; never let a bad match move one backwards.
    located.push({ ...e, charStart: Math.max(charStart, floor), exact });
    floor = located[located.length - 1].charStart;
  }

  for (let i = 0; i < located.length; i++) {
    const next = located[i + 1];
    located[i].ownEnd = next ? next.charStart : docLength;

    let end = docLength;
    for (let j = i + 1; j < located.length; j++) {
      if (located[j].depth <= located[i].depth) { end = located[j].charStart; break; }
    }
    located[i].charEnd = Math.max(end, located[i].ownEnd);
    located[i].startPage = located[i].page;
    located[i].endPage = pageAtOffset(pages, Math.max(located[i].charEnd - 1, located[i].charStart));
  }
  return located;
}

/** Nest a flat, depth-annotated list. Depth jumps are tolerated. */
export function buildTree(located) {
  const root = { nodes: [] };
  const stack = [root];
  let counter = 0;

  for (const e of located) {
    const node = {
      title: e.title,
      node_id: String(counter++).padStart(4, '0'),
      start_index: e.startPage,
      end_index: e.endPage,
      char_start: e.charStart,
      char_end: e.charEnd,
      own_end: e.ownEnd,
      source: e.signal || 'outline',
      verification: e.status,
      coverage: e.coverage !== undefined ? Math.round(e.coverage * 100) / 100 : undefined,
      nodes: [],
    };
    while (stack.length > e.depth + 1) stack.pop();
    while (stack.length < e.depth + 1) {
      // Depth jumped without an intermediate parent; attach to the deepest node.
      const host = stack[stack.length - 1];
      if (!host.nodes.length) break;
      stack.push(host.nodes[host.nodes.length - 1]);
    }
    stack[stack.length - 1].nodes.push(node);
    stack.push(node);
  }

  const prune = (nodes) => nodes.map((n) => {
    const kids = prune(n.nodes);
    const out = { ...n };
    if (kids.length) out.nodes = kids; else delete out.nodes;
    if (out.coverage === undefined) delete out.coverage;
    return out;
  });
  return prune(root.nodes);
}

export const sectionText = (doc, node) => doc.fullText.slice(node.char_start, node.char_end);
