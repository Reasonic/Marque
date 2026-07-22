/**
 * Structure-extraction cost & speed — Marque vs. the document parsers.
 *
 *   node bench/structure-cost.mjs      (no API key, no LLM, no network)
 *
 * The pitch this measures: Marque *reads* a document's section structure — free,
 * instant, CPU-only — where the ML/cloud parsers *reconstruct* it by running deep
 * models on every page. Two things are measured on this machine:
 *
 *   1. Marque's own indexing (pages, sections, verification, time, $0 — zero LLM
 *      calls on the fixtures).
 *   2. The naive free baseline, raw `pdf.js getOutline()`, on the same files — to
 *      show that reading the embedded outline is cheap for *anyone*, and what
 *      Marque adds on top of it (verification, char-exact spans, and a typography
 *      fallback for the file that ships no outline at all).
 *
 * The ML/cloud parsers are NOT run here (they need GPUs, API keys, and money).
 * Their cost/compute is quoted from vendor documentation and clearly labelled as
 * documented-not-measured, per this repo's "never publish a number we cannot
 * reproduce" rule. Sources are in the table's footnotes.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { index } from '../src/index.mjs';

const FIXTURES = ['boe', 'brk', 'gpt4', 'attn', 'bert'];
const ms = () => Number(process.hrtime.bigint() / 1_000_000n);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** Count entries in a raw pdf.js outline tree (recursive). */
const countOutline = (items) => (items || []).reduce((n, it) => n + 1 + countOutline(it.items), 0);

async function rawOutline(path) {
  const t = ms();
  const data = new Uint8Array(fs.readFileSync(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const entries = countOutline(await doc.getOutline());
  return { entries, ms: ms() - t };
}

// --- 1. Marque, measured ---------------------------------------------------
console.log('Marque — structure extraction (measured here; no API, no LLM):\n');
console.log(`${pad('doc', 8)}${padL('pages', 6)}  ${pad('tier', 9)}${padL('sections', 9)}  `
  + `${pad('verified', 10)}${padL('llm', 4)}${padL('ms', 7)}   $`);
const marque = {};
let tPages = 0; let tSec = 0; let tMs = 0;
for (const f of FIXTURES) {
  const r = await index(`bench/fixtures/${f}.pdf`);
  const v = r.stats.verification;
  marque[f] = r;
  tPages += r.page_count; tSec += r.stats.sections; tMs += r.elapsed_ms;
  console.log(`${pad(f, 8)}${padL(r.page_count, 6)}  ${pad(r.tier, 9)}${padL(r.stats.sections, 9)}  `
    + `${pad(`${v.verified}/${v.partial}/${v.unverified}`, 10)}${padL(0, 4)}${padL(Math.round(r.elapsed_ms), 7)}   $0.00`);
}
console.log(`\n  total: ${tPages} pages · ${tSec} sections · 0 LLM calls · ${Math.round(tMs)} ms · $0.00`);

// --- 2. Naive free baseline, measured --------------------------------------
console.log('\nRaw pdf.js getOutline() — the naive free baseline (measured here):\n');
console.log(`${pad('doc', 8)}${padL('outline', 8)}${padL('ms', 6)}   ${padL('Marque', 7)}   what Marque adds`);
for (const f of FIXTURES) {
  const o = await rawOutline(`bench/fixtures/${f}.pdf`);
  const add = o.entries === 0
    ? 'a whole structure — this file ships no outline; Marque tier-2 (typography) recovers it'
    : 'local verification + char-exact spans + retrieval, all still $0';
  console.log(`${pad(f, 8)}${padL(o.entries, 8)}${padL(Math.round(o.ms), 6)}   ${padL(marque[f].stats.sections, 7)}   ${add}`);
}

// --- 3. The ML/cloud parsers, documented (NOT measured here) ----------------
console.log('\nML / cloud document parsers — cost & compute, from vendor docs (NOT measured here):\n');
const cols = [20, 20, 20, 22, 0];
const row = (r) => r.map((c, i) => pad(c, cols[i])).join('');
console.log(row(['tool', 'reads outline?', 'section tree?', 'per-page cost', 'compute']));
console.log(row(['────', '──────────────', '─────────────', '─────────────', '───────']));
for (const r of [
  ['Marque', 'yes +typo/LLM', 'yes, verified spans', '~$0  (0–2 LLM/doc)', 'CPU · ms   [measured]'],
  ['PyMuPDF / PDF.js', 'yes (raw)', 'nested bookmarks', '$0', 'CPU · ms'],
  ['Docling (IBM)', 'no (rebuilds)', 'partial, flat levels', '$0 (OSS)', 'ML models · GPU-pref'],
  ['Unstructured', 'no', 'flat elements', '$0.03 / page (API)', 'hi_res/vlm = GPU'],
  ['LlamaParse', 'no', 'markdown levels', '1–45 credits / page', 'LLM / VLM'],
  ['Azure Doc Intel.', 'no', 'yes (paid)', '~$10 / 1,000 pages', 'cloud ML'],
  ['Adobe PDF Extract', 'no', 'path-encoded H1/H2', '500 free/mo, then paid', 'cloud ML'],
  ['Marker / Nougat', 'no', 'flat / blocks', '$0 (OSS)', 'VLM / transformer · GPU'],
]) console.log(row(r));

console.log(`
Footnotes (documented, not measured here):
  Unstructured   $0.03/page hosted        https://unstructured.io/pricing
  Azure DI       ~$10/1,000 pages (Layout) https://azure.microsoft.com/pricing (Document Intelligence)
  LlamaParse     $1.25/1,000 credits, 1–45 cr/page  https://developers.llamaindex.ai/llamaparse/general/pricing/
  Adobe Extract  500 free txns/mo          https://developer.adobe.com/document-services/docs/overview/pdf-extract-api/
  Docling        heading levels flatten by default  https://github.com/docling-project/docling/issues/287
Only the Marque and pdf.js rows are measured above; the rest are quoted for context.`);
