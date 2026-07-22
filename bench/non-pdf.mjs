/**
 * Non-PDF structure extraction — the data point for Markdown/HTML.
 *
 *   npm run bench:non-pdf
 *   node bench/non-pdf.mjs path/to/doc.md path/to/page.html
 *
 * On PDF, tier-1 works only when the file ships an outline, and tier-2 typography
 * recovers ~57% of headings (see bench/structure-accuracy). On structured-text
 * formats there is nothing to recover: the markup *states* the structure, so it
 * resolves at tier 1, exactly, with zero LLM calls and no verification failures.
 * This measures that on real documents (this repo's own docs, by default).
 *
 * Deterministic, no network, $0.
 */
import fs from 'node:fs';
import { index } from '../src/index.mjs';

const DEFAULTS = [
  'README.md',
  'bench/README.md',
  'bench/financebench/README.md',
  'bench/qasper/README.md',
  'bench/structure-accuracy.md',
  'test/fixtures/sample.md',
  'test/fixtures/sample.html',
  'test/fixtures/sample.docx',
  'test/fixtures/sample.epub',
  'test/fixtures/sample.txt',
].map((p) => new URL(`../${p}`, import.meta.url).pathname);

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;

console.log(`${'document'.padEnd(30)} ${'fmt'.padEnd(4)} ${'tier'.padEnd(8)} ${'secs'.padStart(5)} `
  + `${'verified'.padStart(9)} ${'llm'.padStart(4)} ${'ms'.padStart(5)}`);

let totSecs = 0; let totVer = 0; let totLlm = 0; let totMs = 0; let n = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`${f.split('/').pop().padEnd(30)} (missing)`); continue; }
  const ext = f.split('.').pop().toLowerCase();
  const label = (f.split('/public/').pop() || f.split('/').pop());
  const r = await index(f);
  const v = r.stats.verification;
  const secs = r.stats.sections;
  console.log(`${label.slice(0, 30).padEnd(30)} ${ext.padEnd(4)} ${r.tier.padEnd(8)} ${String(secs).padStart(5)} `
    + `${`${v.verified}/${secs}`.padStart(9)} ${String(r.llm_calls).padStart(4)} ${String(r.elapsed_ms).padStart(5)}`);
  totSecs += secs; totVer += v.verified; totLlm += r.llm_calls; totMs += r.elapsed_ms; n++;
}

console.log(`\n${n} documents · ${totSecs} sections · ${totVer}/${totSecs} verified `
  + `(${(100 * totVer / (totSecs || 1)).toFixed(1)}%) · ${totLlm} LLM calls · ${totMs} ms total · $0`);
console.log('Structured-text formats state their structure; Marque reads it. Nothing to reconstruct.');
