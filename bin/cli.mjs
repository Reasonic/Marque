#!/usr/bin/env node
import { index, query, createLLM } from '../src/index.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const useLlm = args.includes('--llm');
const qFlag = args.indexOf('--query');
const question = qFlag !== -1 ? args[qFlag + 1] : null;
const files = args.filter((a, i) => !a.startsWith('--') && !(qFlag !== -1 && i === qFlag + 1));

if (!files.length) {
  console.error('usage: vectorless <file.pdf ...> [--json] [--query "question"] [--llm]');
  console.error('  --llm  enable tier 3 and LLM retrieval via ANTHROPIC_API_KEY / OPENAI_API_KEY');
  process.exit(1);
}

// createLLM() throws with guidance if no provider key is configured.
let llm = null;
if (useLlm) {
  try {
    llm = createLLM();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const printTree = (nodes, depth = 0) => {
  for (const n of nodes) {
    const mark = { verified: '✓', partial: '~', unverified: '?' }[n.verification] ?? ' ';
    const pages = n.start_index === n.end_index ? `p${n.start_index}` : `p${n.start_index}-${n.end_index}`;
    console.log(`  ${mark} ${'  '.repeat(depth)}${n.title.slice(0, 62).padEnd(64 - depth * 2)} ${pages}`);
    if (n.nodes) printTree(n.nodes, depth + 1);
  }
};

for (const f of files) {
  const r = await index(f, { llm });

  if (question) {
    // Without --llm: BM25 selection only, zero LLM calls. With --llm: the
    // selector and answerer run through the configured provider.
    const res = await query(r, question, { llm });
    if (json) { console.log(JSON.stringify({ ...res, context: undefined }, null, 2)); continue; }
    console.log(`\n${r.doc_name} — "${question}"`);
    console.log(`  selection=${res.selection_by}  llm_calls=${res.tokens.llm_calls}  `
      + `context=${res.tokens.context} tok`);
    console.log('  selected:');
    for (const s of res.sections) {
      console.log(`    [${s.node_id}] ${s.title.slice(0, 56).padEnd(58)} p${s.pages[0]}-${s.pages[1]}`);
    }
    console.log('  bm25 ranking:');
    for (const c of res.candidates.slice(0, 6)) {
      console.log(`    ${String(c.score).padStart(6)}  [${c.node_id}] ${c.title.slice(0, 52)}`);
    }
    continue;
  }

  if (json) {
    const { _doc, ...out } = r;
    console.log(JSON.stringify(out, null, 2));
    continue;
  }
  const v = r.stats.verification;
  console.log(`\n${r.doc_name} — ${r.page_count} pages`);
  console.log(`  tier=${r.tier}  llm_calls=${r.llm_calls}  ${r.elapsed_ms}ms`);
  console.log(`  ${r.stats.sections} sections · ${r.stats.exact_offsets} exact offsets · `
    + `${v.verified} verified, ${v.partial} partial, ${v.unverified} unverified`);
  printTree(r.structure);
  if (r.stats.needs_review.length) {
    console.log(`  needs tier-3 review (${r.stats.needs_review.length}): `
      + r.stats.needs_review.slice(0, 4).map((t) => `"${t.slice(0, 34)}"`).join(', '));
  }
}
