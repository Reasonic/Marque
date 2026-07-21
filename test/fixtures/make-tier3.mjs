/**
 * Generate tier3.pdf — a fixture that forces tier 3 (LLM structure inference).
 *
 * Every current benchmark fixture resolves at tier 1 (embedded outline) or
 * tier 2 (typography). None exercise inferStructure(). This document is what a
 * Word-exported or scanned-then-OCR'd file looks like to the indexer:
 *
 *   - No embedded outline        → tier 1 finds nothing (no /Outlines below).
 *   - Uniform typography         → tier 2 finds nothing: every line, heading or
 *     body, is Helvetica 11pt and unnumbered, so no candidate is ever bigger,
 *     bold, or numbered, and section titles are non-keyword words.
 *
 * With both cheap tiers blank, index() falls through to inferStructure().
 *
 * Dependency-free by design: the repo is ESM/.mjs with no build step, so the
 * fixture is reproduced with `node test/fixtures/make-tier3.mjs`, not a Python
 * toolchain. The output is committed so `npm test` needs no generation step.
 */
import fs from 'node:fs';

const FONT_SIZE = 11;
const LEADING = 15;
const MARGIN_X = 72;
const TOP_Y = 740;
const BOTTOM_Y = 72;
const WRAP = 92; // characters per line — approximate, a fixture need not be typeset

// Non-keyword, unnumbered section titles: nothing here trips a tier-2 signal.
const TITLE = 'Notes on Distributed Cache Invalidation';
const SECTIONS = [
  ['Overview', [
    'This note records how a small distributed cache keeps its entries consistent when several writers touch the same keys. It assumes no shared clock and no central coordinator, which is the setting most services actually run in.',
    'The goal is not a proof but a shared vocabulary, so the later sections can refer back to the same terms without redefining them each time.',
  ]],
  ['Cache Coherence', [
    'A read should never return a value older than one the same client has already observed. That single rule, monotonic reads, is weaker than linearizability but strong enough for session-scoped work, and it is cheap to provide with per-client version stamps.',
    'Coherence across clients is a separate question and is handled by the invalidation path rather than by the read path.',
  ]],
  ['Invalidation Strategies', [
    'Two families exist. Write-through invalidation evicts an entry the moment its backing record changes, trading write latency for freshness. Lease-based invalidation lets an entry live until its lease expires, trading freshness for far less coordination traffic.',
    'The cache described here uses leases for hot keys and write-through for the small set of keys marked authoritative, because their staleness budget is effectively zero.',
  ]],
  ['Write Propagation', [
    'When a record changes, the writer publishes the key and a monotonically increasing version to a fan-out topic. Each cache node applies the eviction only if the published version exceeds the version it currently holds, so reordered messages are harmless.',
    'Propagation is best-effort. A node that misses a message will still converge once the entry lease expires, which bounds the worst-case staleness to the lease duration.',
  ]],
  ['Failure Modes', [
    'The interesting failures are partial. A node partitioned from the fan-out topic keeps serving reads from leases that have not yet expired, so it can serve values other nodes have already invalidated. This is acceptable precisely because leases are short.',
    'A writer that crashes after mutating the record but before publishing leaves every cache stale until the lease expires. Shortening the lease narrows this window at the cost of more misses.',
  ]],
  ['Evaluation', [
    'On a synthetic workload with a ninety-ten read-write split, lease durations between two and ten seconds kept the observed staleness under one lease duration in every run, while coordination traffic fell by roughly an order of magnitude against write-through everywhere.',
    'The authoritative-key set stayed small enough that its write-through cost was not measurable against the background load.',
  ]],
  ['Closing Notes', [
    'None of this is novel; it is the folklore written down so the next person does not have to reconstruct it from the code. The one non-obvious point is that reordered invalidations are safe as long as versions are compared, never assumed.',
  ]],
];

/** Wrap a paragraph into lines of at most WRAP characters, on word boundaries. */
function wrap(text) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > WRAP) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

const escape = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

// Flow every line into pages. A "line" is just text plus how much vertical space
// precedes it, so a heading gets a blank line above without any style change.
const doc = [{ text: TITLE, gap: 0 }];
for (const [heading, paras] of SECTIONS) {
  doc.push({ text: heading, gap: LEADING });
  for (const p of paras) for (const l of wrap(p)) doc.push({ text: l, gap: 0 });
}

const pages = [];
let cursor = TOP_Y;
let ops = [];
for (const { text, gap } of doc) {
  cursor -= gap;
  if (cursor < BOTTOM_Y) { pages.push(ops); ops = []; cursor = TOP_Y; }
  ops.push(`BT /F1 ${FONT_SIZE} Tf 1 0 0 1 ${MARGIN_X} ${cursor} Tm (${escape(text)}) Tj ET`);
  cursor -= LEADING;
}
if (ops.length) pages.push(ops);

// --- Assemble the PDF. Object numbering: 1 Catalog, 2 Pages, 3 Font, then a
// (content, page) pair per page. No /Outlines anywhere — that is the point.
const streams = pages.map((ops) => ops.join('\n'));
const N = streams.length;
const pageNums = streams.map((_, i) => 5 + i * 2);

const parts = [];
parts[1] = '<< /Type /Catalog /Pages 2 0 R >>';
parts[2] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${N} >>`;
parts[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
streams.forEach((stream, i) => {
  const contentNum = 4 + i * 2;
  const pageNum = 5 + i * 2;
  parts[contentNum] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  parts[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
    + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
});

const maxNum = 3 + N * 2;
let out = '%PDF-1.4\n';
const offsets = [];
for (let n = 1; n <= maxNum; n++) {
  offsets[n] = Buffer.byteLength(out, 'latin1');
  out += `${n} 0 obj\n${parts[n]}\nendobj\n`;
}
const xref = Buffer.byteLength(out, 'latin1');
out += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
for (let n = 1; n <= maxNum; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
out += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

const path = new URL('./tier3.pdf', import.meta.url);
fs.writeFileSync(path, Buffer.from(out, 'latin1'));
console.log(`wrote ${fs.statSync(path).size} bytes, ${N} pages`);
