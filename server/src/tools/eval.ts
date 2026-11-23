import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createLLM } from '../llm-providers.js';
import { NoLLM } from '../llm.js';
import { loadCases } from '../eval/cases.js';
import { formatReport, runEval } from '../eval/run.js';

/**
 * `npm run eval` — score the AI pipeline on the labelled cases in `server/eval/cases/`.
 *
 *   npm run eval                       # the models from LLM_PROVIDERS (rules only without keys)
 *   npm run eval -- --rules            # keyword rules only, no model calls
 *   npm run eval -- --set synthetic-de # one case file
 *   npm run eval -- --json report.json # also write the full report
 *
 * Prices for the cost line come from LLM_PRICE_IN/OUT_EUR_PER_MTOK. Nothing is written to the
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

const llm = args.includes('--rules') ? new NoLLM() : createLLM(config);
const label = llm instanceof NoLLM ? 'rules' : (llm.names.join(' → ') || 'rules');
const report = await runEval(cases, { llm, priceInPerMTok: config.llmPriceInPerMTok, priceOutPerMTok: config.llmPriceOutPerMTok });
console.log(formatReport(report, label));
const out = flag('--json');
if (out) { writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), ...report }, null, 1)); console.log(`\nFull report: ${out}`); }
