import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createLLM } from '../llm-providers.js';
import { NoLLM } from '../llm.js';
import { loadCases } from '../eval/cases.js';
import { formatReport, runEval, type EvalReport } from '../eval/run.js';
import { formatComparison, type CompareRow } from '../eval/compare.js';

/**
 * `npm run eval` — score the AI pipeline on the labelled cases in `server/eval/cases/`.
 *
 *   npm run eval                       # the models from LLM_PROVIDERS (rules only without keys)
 *   npm run eval -- --rules            # keyword rules only, no model calls
 *   npm run eval -- --set synthetic-de # one case file
 *   npm run eval -- --json report.json # also write the full report
 *   npm run eval -- --compare          # each provider in LLM_PROVIDERS on its own + the rules,
 *                                      # side by side, with a suggested LLM_PROVIDERS order
 *
 * Prices for the cost line come from LLM_PRICE_IN/OUT_EUR_PER_MTOK; with --compare, a provider's
 * own price can be set as LLM_PRICE_<NAME>_IN/OUT_EUR_PER_MTOK (e.g. LLM_PRICE_MISTRAL_IN_EUR_PER_MTOK). Nothing is written to the
 * database and the daily AI budget is not touched (this runs outside the server).
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const config = loadConfig();
let cases = loadCases(join(root, 'eval', 'cases'), join(root, 'test', 'fixtures'));
const set = flag('--set');
if (set) cases = cases.filter((c) => c.set === set);
if (!cases.length) { console.error(`No cases${set ? ` in set "${set}"` : ''}.`); process.exit(1); }

const out = flag('--json');
const save = (data: unknown) => { if (out) { writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...(data as object) }, null, 1)); console.log(`\nFull report: ${out}`); } };

if (args.includes('--compare')) {
  const baseline = await runEval(cases, { llm: new NoLLM(), priceInPerMTok: 0, priceOutPerMTok: 0 });
  const rows: CompareRow[] = [];
  for (const name of config.llmProviders) {
    const llm = createLLM({ ...config, llmProviders: [name] });
    if (!llm.enabled) { console.log(`skipping ${name}: no key or URL set`); continue; }
    const env = (k: string) => process.env[`LLM_PRICE_${name.toUpperCase()}_${k}_EUR_PER_MTOK`];
    const priceIn = Number(env('IN') ?? config.llmPriceInPerMTok);
    const priceOut = Number(env('OUT') ?? config.llmPriceOutPerMTok);
    console.log(`running ${name} on ${cases.length} cases …`);
    rows.push({ name, report: await runEval(cases, { llm, priceInPerMTok: priceIn, priceOutPerMTok: priceOut }) });
  }
  console.log(`\nHey-Okay AI provider comparison · ${cases.length} cases\n`);
  console.log(formatComparison(rows, baseline));
  save({ rows: rows.map((r) => ({ name: r.name, ...r.report })), baseline });
} else {
  const llm = args.includes('--rules') ? new NoLLM() : createLLM(config);
  const label = llm instanceof NoLLM ? 'rules' : (llm.names.join(' → ') || 'rules');
  const report: EvalReport = await runEval(cases, { llm, priceInPerMTok: config.llmPriceInPerMTok, priceOutPerMTok: config.llmPriceOutPerMTok });
  console.log(formatReport(report, label));
  save({ label, ...report });
}
