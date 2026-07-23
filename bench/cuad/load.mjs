/**
 * CUAD loader — the Atticus Contract Understanding Dataset (SQuAD 2.0 format).
 *
 * 510 commercial contracts, each with 41 clause-category questions whose answers
 * are highlighted spans in the contract text (or marked impossible when the
 * category is absent). Like the other fixtures this is other people's data (MIT /
 * CC BY 4.0), fetched on demand and cached under bench/cuad/data/, never committed.
 *
 * We materialise each contract's own text (the dataset's `context`) to a .txt file
 * and let Marque index it through the ordinary path — so the benchmark tests
 * Marque *detecting the contract's clause structure*, then retrieving within it,
 * not a pre-segmented tree. Scoring is offset-based against the gold spans, so no
 * LLM grader is involved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const TXT = path.join(DATA, 'txt');
const JSON_PATH = path.join(DATA, 'CUAD_v1.json');
const URL = 'https://huggingface.co/datasets/theatticusproject/cuad/resolve/main/CUAD_v1/CUAD_v1.json';

/** A filesystem-safe basename for a contract title. */
const safe = (title) => title.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

/** The clause category is the CUAD question id's suffix ("…__Governing Law"). */
const categoryOf = (id) => id.split('__').pop();

/** Split a CUAD question into the searchable need: the category plus its "Details:" gloss. */
function queryOf(qa) {
  const category = categoryOf(qa.id);
  const m = /Details:\s*(.+)$/s.exec(qa.question || '');
  return { category, query: m ? `${category}. ${m[1].trim()}` : category };
}

/**
 * Load CUAD, fetching + caching the 40 MB JSON on first use. Returns an array of
 * contracts, each with its text written to a cached .txt and its answerable
 * questions parsed. `is_impossible` questions (the category is absent) are dropped —
 * there is nothing to retrieve.
 * @returns {Array<{title, txtPath, context, questions: Array<{category, query, answers: Array<{text, start}>}>}>}
 */
export function loadContracts() {
  if (!fs.existsSync(JSON_PATH)) {
    console.log('fetching CUAD_v1.json (Atticus, ~40MB)…');
    fs.mkdirSync(DATA, { recursive: true });
    execSync(`curl -sL -o "${JSON_PATH}" "${URL}"`, { stdio: 'inherit' });
  }
  fs.mkdirSync(TXT, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  const contracts = [];
  for (const entry of raw.data) {
    const para = entry.paragraphs[0];
    const context = para.context;
    const txtPath = path.join(TXT, `${safe(entry.title)}.txt`);
    if (!fs.existsSync(txtPath)) fs.writeFileSync(txtPath, context);

    const questions = [];
    for (const qa of para.qas) {
      if (qa.is_impossible || !qa.answers?.length) continue;
      const { category, query } = queryOf(qa);
      // De-duplicate identical answer spans; keep text + start offset.
      const seen = new Set();
      const answers = [];
      for (const a of qa.answers) {
        const key = `${a.answer_start}:${a.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        answers.push({ text: a.text, start: a.answer_start });
      }
      questions.push({ category, query, answers });
    }
    if (questions.length) contracts.push({ title: entry.title, txtPath, context, questions });
  }
  return contracts;
}
