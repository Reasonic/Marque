/**
 * FinanceBench loader — the 150-question public subset and its source filings.
 *
 * Like the other fixtures, this is other people's data (Patronus AI's
 * FinanceBench, and SEC filings), so it is fetched on demand and cached, never
 * committed. Cache lives under bench/financebench/{data,pdfs}/ (gitignored).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const PDFS = path.join(HERE, 'pdfs');
const RAW = 'https://raw.githubusercontent.com/patronus-ai/financebench/main';

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buf);
  return buf;
}

/** The 150 questions, downloaded once and cached. */
export async function loadQuestions() {
  const dest = path.join(DATA, 'financebench_open_source.jsonl');
  if (!fs.existsSync(dest)) {
    await download(`${RAW}/data/financebench_open_source.jsonl`, dest);
  }
  return fs.readFileSync(dest, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

/** Ensure a filing PDF is cached locally; returns its path. */
export async function ensurePdf(docName) {
  const dest = path.join(PDFS, `${docName}.pdf`);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
    const buf = await download(`${RAW}/pdfs/${docName}.pdf`, dest);
    if (buf.subarray(0, 4).toString() !== '%PDF') { fs.rmSync(dest); throw new Error(`${docName}: not a PDF`); }
  }
  return dest;
}

/**
 * Choose a subset that maximizes questions per document (documents are the cost
 * driver — the baseline contextualizes every chunk of each one). Greedily takes
 * the most-covered documents until `maxQuestions` is reached. Bias toward a few
 * companies is the price of a subset; it is stated in the report.
 * @returns {{questions: Array, docs: string[]}}
 */
export function pickSubset(all, maxQuestions) {
  if (!maxQuestions || maxQuestions >= all.length) {
    return { questions: all, docs: [...new Set(all.map((q) => q.doc_name))] };
  }
  const byDoc = new Map();
  for (const q of all) (byDoc.get(q.doc_name) || byDoc.set(q.doc_name, []).get(q.doc_name)).push(q);
  const ranked = [...byDoc.entries()].sort((a, b) => b[1].length - a[1].length);

  const questions = [];
  const docs = [];
  for (const [doc, qs] of ranked) {
    if (questions.length >= maxQuestions) break;
    docs.push(doc);
    questions.push(...qs);
  }
  return { questions, docs };
}
