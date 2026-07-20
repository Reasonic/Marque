/**
 * Tier 3 — LLM structure inference, for what tiers 1 and 2 cannot resolve.
 *
 * Two jobs, both deliberately narrow:
 *   A. adjudicate()      resolve entries local verification could not confirm
 *   B. inferStructure()  recover headings when a document declares none
 *
 * Three rules separate this from PageIndex's approach:
 *
 *   1. BATCHED. PageIndex spends one call per section on verification and
 *      another per repair. Here many entries share one call, bounded by tokens.
 *   2. INDEPENDENT WINDOWS. PageIndex's no-TOC path conditions each window on
 *      the tree built so far (generate_toc_continue), making it strictly
 *      sequential. These windows are independent, so they run concurrently.
 *   3. NEVER GUESS. An unresolved entry stays unverified. Low confidence never
 *      overwrites a page number that local evidence did not contradict —
 *      PageIndex's repair loop can "fix" a correct index into a wrong one.
 */
import { countTokens } from '../retrieve/payload.mjs';
import { verifyEntry, VERIFIED, UNVERIFIED } from './verify.mjs';

const DEFAULTS = {
  windowTokens: 700,     // context shown per entry during adjudication
  batchTokens: 8000,     // token ceiling per adjudication call
  chunkTokens: 12000,    // window size for structure inference
  chunkOverlap: 1,       // pages of overlap between windows
};

/** Text around a claimed page: tail of the previous page, then the page itself. */
function pageWindow(doc, page, budget) {
  const prev = doc.pages[page - 2];
  const cur = doc.pages[page - 1];
  if (!cur) return '';
  const head = cur.text.slice(0, budget * 4);
  const tail = prev ? prev.text.slice(-budget) : '';
  return (tail ? `…${tail}\n---[page ${page - 1} ends]---\n` : '') + `[page ${page}]\n${head}`;
}

function batch(items, cost, ceiling) {
  const batches = [];
  let current = [];
  let used = 0;
  for (const item of items) {
    const c = cost(item);
    if (current.length && used + c > ceiling) { batches.push(current); current = []; used = 0; }
    current.push(item);
    used += c;
  }
  if (current.length) batches.push(current);
  return batches;
}

const ADJUDICATE_PROMPT = `For each numbered item you are given a section title and the text near the page it is claimed to start on.

Decide, for each item, whether that section actually starts on the claimed page.
Titles are often labels rather than the literal heading printed on the page — "Chairman's Letter" may appear as "To the Shareholders". Treat a plausible match as correct.

Reply with JSON only:
{"results":[{"id":<number>,"starts_here":true|false,"page":<corrected page or null>,"confident":true|false}]}

Set confident=false whenever you are unsure. An unsure answer is kept as-is, so guessing only causes harm.`;

/**
 * Resolve entries local verification could not confirm.
 * @returns {{entries: Array, calls: number, tokens: number, resolved: number}}
 */
export async function adjudicate(doc, entries, llm, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const pending = entries
    .map((e, i) => ({ ...e, _i: i }))
    .filter((e) => e.status === UNVERIFIED);

  if (!pending.length || !llm?.json) {
    return { entries, calls: 0, tokens: 0, resolved: 0 };
  }

  const withWindows = pending.map((e) => ({ ...e, window: pageWindow(doc, e.page, cfg.windowTokens) }));
  const batches = batch(withWindows, (e) => countTokens(e.window) + 40, cfg.batchTokens);

  const out = entries.map((e) => ({ ...e }));
  let calls = 0;
  let tokens = 0;
  let resolved = 0;

  const results = await Promise.all(batches.map(async (group) => {
    const body = group
      .map((e, n) => `--- item ${n} ---\ntitle: ${e.title}\nclaimed page: ${e.page}\n${e.window}`)
      .join('\n\n');
    const prompt = `${ADJUDICATE_PROMPT}\n\n${body}`;
    calls++;
    tokens += countTokens(prompt);
    const reply = await llm.json(prompt);
    return { group, reply };
  }));

  for (const { group, reply } of results) {
    for (const r of reply?.results ?? []) {
      const entry = group[r.id];
      if (!entry || !r.confident) continue;

      const target = out[entry._i];
      if (r.starts_here) {
        target.status = VERIFIED;
        target.adjudicated = 'confirmed';
        resolved++;
      } else if (Number.isInteger(r.page) && r.page >= 1 && r.page <= doc.numPages) {
        // A relocation is only accepted when the destination page independently
        // confirms the title. "No worse than before" is not enough: for an entry
        // that verifies nowhere, any page clears that bar, which is how a
        // hallucinated page number silently corrupts an index.
        //
        // The original page came from the document's own outline. An LLM
        // disagreement that local evidence cannot corroborate does not overturn it.
        const moved = verifyEntry({ ...entry, page: r.page }, doc.pages);
        if (moved.status !== UNVERIFIED && moved.coverage > (entry.coverage ?? 0)) {
          target.page = r.page;
          target.status = moved.status;
          target.coverage = moved.coverage;
          target.adjudicated = 'moved';
          resolved++;
        }
      }
    }
  }

  return { entries: out, calls, tokens, resolved };
}

const INFER_PROMPT = `Extract the section headings from this portion of a document.

Return only real structural headings — section and subsection titles. Ignore running headers, footers, page numbers, figure and table captions, and body text.
Each page is marked with [page N]; report the page each heading starts on.
level 0 = top-level section, 1 = subsection, 2 = sub-subsection.

Reply with JSON only:
{"headings":[{"title":"...","page":<number>,"level":<0|1|2>}]}

If this portion contains no headings, return an empty list.`;

/**
 * Recover structure for documents that declare none.
 *
 * Windows are independent and run concurrently — unlike PageIndex, whose
 * equivalent path feeds each window the tree built so far and is therefore
 * strictly sequential.
 */
export async function inferStructure(doc, llm, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!llm?.json) return { entries: [], calls: 0, tokens: 0 };

  const marked = doc.pages.map((p) => ({ page: p.page, text: `[page ${p.page}]\n${p.text}` }));
  const windows = batch(marked, (p) => countTokens(p.text), cfg.chunkTokens);

  let calls = 0;
  let tokens = 0;

  const replies = await Promise.all(windows.map(async (win, i) => {
    const overlap = i > 0 ? marked.slice(Math.max(0, marked.indexOf(win[0]) - cfg.chunkOverlap), marked.indexOf(win[0])) : [];
    const prompt = `${INFER_PROMPT}\n\n${[...overlap, ...win].map((p) => p.text).join('\n\n')}`;
    calls++;
    tokens += countTokens(prompt);
    const reply = await llm.json(prompt);
    return { pages: new Set(win.map((p) => p.page)), reply };
  }));

  // Merge, keeping only headings whose page belongs to the window that found it
  // (overlap regions would otherwise produce duplicates).
  const seen = new Set();
  const entries = [];
  for (const { pages, reply } of replies) {
    for (const h of reply?.headings ?? []) {
      if (!h?.title || !Number.isInteger(h.page) || !pages.has(h.page)) continue;
      const key = `${h.page}:${h.title.toLowerCase().trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        title: String(h.title).trim(),
        page: h.page,
        depth: Math.min(Math.max(Number(h.level) || 0, 0), 3),
        signal: 'llm',
        confidence: 'medium',
      });
    }
  }

  entries.sort((a, b) => a.page - b.page || a.depth - b.depth);
  return { entries, calls, tokens };
}
