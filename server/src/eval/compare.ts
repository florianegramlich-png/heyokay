import type { EvalReport } from './run.js';

/**
 * Comparing AI providers on the eval set (PRD 6.4, Decision 12): one row per provider, plus the
 * keyword-rules baseline, and a suggested `LLM_PROVIDERS` order.
 *
 * The order: providers that don't beat the rules on extraction accuracy are dropped (failing over
 * to them would be worse than the templates). Of the rest, the best quality comes first, where
 * quality is extraction accuracy, then exact severity, then verifier pass rate. Providers within
 * QUALITY_TIE of the best accuracy count as equally good, and among those the cheaper goes first.
 */
export const QUALITY_TIE = 0.02;

export interface CompareRow {
  name: string;
  report: EvalReport;
}

export interface Suggestion {
  order: string[];
  dropped: Array<{ name: string; reason: string }>;
}

const num = (x: number | null | undefined) => x ?? 0;

export function suggestOrder(rows: CompareRow[], baseline: EvalReport | null): Suggestion {
  const floor = baseline ? baseline.extraction.accuracy : -1;
  const dropped: Suggestion['dropped'] = [];
  const kept: CompareRow[] = [];
  for (const r of rows) {
    if (r.report.cost.calls === 0) dropped.push({ name: r.name, reason: 'no answers (key, URL or model wrong?)' });
    else if (r.report.extraction.accuracy <= floor) dropped.push({ name: r.name, reason: 'not better than the keyword rules' });
    else kept.push(r);
  }
  const best = Math.max(...kept.map((r) => r.report.extraction.accuracy), 0);
  const tier = (r: CompareRow) => (best - r.report.extraction.accuracy <= QUALITY_TIE ? 0 : 1);
  kept.sort((a, b) =>
    tier(a) - tier(b)
    || (tier(a) === 0 ? a.report.cost.eurPerEvent - b.report.cost.eurPerEvent : 0)
    || b.report.extraction.accuracy - a.report.extraction.accuracy
    || num(b.report.severity.exact) - num(a.report.severity.exact)
    || num(b.report.verifier.passRate) - num(a.report.verifier.passRate)
    || a.report.cost.eurPerEvent - b.report.cost.eurPerEvent);
  return { order: kept.map((r) => r.name), dropped };
}

const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`);
const pad = (s: string, n: number) => s.padEnd(n);

export function formatComparison(rows: CompareRow[], baseline: EvalReport | null): string {
  const all = baseline ? [...rows, { name: 'rules (baseline)', report: baseline }] : rows;
  const head = ['provider', 'extraction', 'precision', 'recall', 'severity =', 'severity ±1', 'verifier', 'template', '€ / event'];
  const body = all.map(({ name, report: r }) => [
    name, pct(r.extraction.accuracy), pct(r.extraction.eventPrecision), pct(r.extraction.eventRecall),
    pct(r.severity.exact), pct(r.severity.withinOne), pct(r.verifier.passRate), pct(r.verifier.templateFallbackRate),
    `€${r.cost.eurPerEvent.toFixed(5)}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)) + 2);
  const lines = [head, ...body].map((row) => row.map((c, i) => pad(c, widths[i])).join('').trimEnd());
  lines.splice(1, 0, '-'.repeat(widths.reduce((a, b) => a + b, 0)));
  const s = suggestOrder(rows, baseline);
  if (!rows.length) lines.push('', 'No provider to compare: set the keys for LLM_PROVIDERS (ANTHROPIC_API_KEY, MISTRAL_API_KEY, OPENAI_COMPAT_URL/MODEL) and run again.');
  else lines.push('', s.order.length ? `Suggested: LLM_PROVIDERS=${s.order.join(',')}` : 'Suggested: no provider beats the keyword rules; keep templates and check the setup.');
  for (const d of s.dropped) lines.push(`  left out: ${d.name} (${d.reason})`);
  return lines.join('\n');
}
