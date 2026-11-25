import type { z } from 'zod';
import type { LlmUsage, StructuredLLM } from '../llm.js';
import type { ExtractedEvent, RiskEvent } from '../types.js';
import { extract } from '../pipeline/extract.js';
import { compose, verify } from '../pipeline/compose.js';
import { factText } from '../pipeline/cluster.js';
import { GazetteerGeocoder, type Geocoder } from '../geocode.js';
import type { EvalCase, Expectation } from './cases.js';

/**
 * Runs the extraction and copy steps of the pipeline over labelled cases and scores them
 * (PRD 6.4, 6.5):
 * - extraction accuracy: alert-or-not right, and for alerts the topic right;
 * - severity agreement: exact and within one level, over cases both sides call an alert;
 * - verifier pass rate: share of AI-written alert texts the fact verifier accepts;
 * - cost per event: model spend at the configured prices, divided by the number of cases.
 *
 * Without a model the pipeline's keyword rules run instead, which gives the baseline any model
 * has to beat. Only public source text is sent to a model, as in production.
 */
export interface EvalOptions {
  llm: StructuredLLM & { onUsage?: (u: LlmUsage) => void };
  /** EUR per million tokens (LLM_PRICE_IN/OUT_EUR_PER_MTOK). */
  priceInPerMTok: number;
  priceOutPerMTok: number;
  geocoder?: Geocoder;
}

export interface CaseResult {
  id: string;
  set: string;
  expect: Expectation;
  got: { isEvent: boolean; category?: string; severity?: number; confidence?: number };
  /** Alert-or-not right and, for alerts, the topic too. */
  correct: boolean;
  /** AI copy attempts and how many the verifier accepted (both 0 without a model). */
  copyAttempts: number;
  copyPassed: number;
  /** Final copy came from the template (no model, or every attempt was rejected). */
  copyTemplate: boolean | null;
  verifierProblems: string[];
}

export interface EvalReport {
  mode: 'model' | 'rules';
  cases: number;
  extraction: { accuracy: number; eventPrecision: number | null; eventRecall: number | null; categoryAccuracy: number | null };
  severity: { compared: number; exact: number | null; withinOne: number | null };
  verifier: { attempts: number; passRate: number | null; firstTryPassRate: number | null; templateFallbackRate: number | null };
  cost: { calls: number; inputTokens: number; outputTokens: number; eur: number; eurPerEvent: number };
  results: CaseResult[];
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function categoryMatches(expect: Expectation, got: string | undefined): boolean {
  if (!expect.category || !got) return false;
  return (Array.isArray(expect.category) ? expect.category : [expect.category]).includes(got as never);
}

/** Records every answer the wrapped model gives, so copy attempts can be checked one by one. */
class RecordingLLM implements StructuredLLM {
  answers: unknown[] = [];
  constructor(private inner: StructuredLLM) {}
  get enabled() { return this.inner.enabled; }
  async generate<T extends z.ZodType>(system: string, user: string, schema: T): Promise<z.infer<T> | null> {
    const out = await this.inner.generate(system, user, schema);
    if (out != null) this.answers.push(out);
    return out;
  }
}

function toRiskEvent(c: EvalCase, e: ExtractedEvent): RiskEvent {
  const now = new Date().toISOString();
  return {
    id: `eval:${c.id}`, category: e.category, severity: e.severity, confidence: e.confidence, official: c.item.official,
    title: e.title, summary: e.summary, areaName: e.areaName, lat: e.lat ?? 0, lon: e.lon ?? 0, radiusM: e.radiusM,
    startsAt: e.startsAt, endsAt: e.endsAt, status: 'pending_review', facts: factText(c.item),
    sources: [{ sourceName: c.item.sourceName, title: c.item.title, official: c.item.official, externalId: c.item.externalId }],
    copyTitle: null, copyBody: null, copyAction: null, copyIsTemplate: true, createdAt: now, updatedAt: now,
    language: c.item.language ?? 'de', revision: 1, country: 'DE',
  };
}

export async function runEval(cases: EvalCase[], o: EvalOptions): Promise<EvalReport> {
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  o.llm.onUsage = (u) => { usage.calls++; usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; };
  const geocoder = o.geocoder ?? new GazetteerGeocoder();
  const results: CaseResult[] = [];

  for (const c of cases) {
    // As if the item had just been published: the extractor drops items older than 12 hours.
    const now = new Date(Date.parse(c.item.publishedAt) + 3600_000);
    const ext = await extract(c.item, { llm: o.llm, geocoder, now, defaultArea: c.defaultArea });
    const got: CaseResult['got'] = ext
      ? { isEvent: true, category: ext.category, severity: ext.severity, confidence: ext.confidence }
      : { isEvent: false };
    const correct = got.isEvent === c.expect.isEvent && (!got.isEvent || categoryMatches(c.expect, got.category));

    let copyAttempts = 0, copyPassed = 0, copyTemplate: boolean | null = null;
    const verifierProblems: string[] = [];
    if (ext) {
      const ev = toRiskEvent(c, ext);
      const rec = new RecordingLLM(o.llm);
      const copy = await compose(ev, rec);
      copyTemplate = copy.isTemplate;
      for (const a of rec.answers as Array<{ title: string; body: string }>) {
        copyAttempts++;
        const problems = verify(a, ev.facts);
        if (problems.length === 0) copyPassed++;
        else verifierProblems.push(...problems);
      }
    }
    results.push({ id: c.id, set: c.set, expect: c.expect, got, correct, copyAttempts, copyPassed, copyTemplate, verifierProblems });
  }

  const n = results.length;
  const predicted = results.filter((r) => r.got.isEvent);
  const actual = results.filter((r) => r.expect.isEvent);
  const both = results.filter((r) => r.got.isEvent && r.expect.isEvent);
  const withSeverity = both.filter((r) => r.expect.severity != null && r.got.severity != null);
  const withCopy = results.filter((r) => r.copyTemplate !== null);
  const tried = withCopy.filter((r) => r.copyAttempts > 0);
  const attempts = results.reduce((s, r) => s + r.copyAttempts, 0);
  const passed = results.reduce((s, r) => s + r.copyPassed, 0);
  // First try passed = one attempt, accepted (compose stops at the first accepted answer).
  const firstTry = tried.filter((r) => r.copyAttempts === 1 && r.copyPassed === 1).length;
  const eur = (usage.inputTokens * o.priceInPerMTok + usage.outputTokens * o.priceOutPerMTok) / 1_000_000;

  return {
    mode: o.llm.enabled ? 'model' : 'rules',
    cases: n,
    extraction: {
      accuracy: n ? results.filter((r) => r.correct).length / n : 0,
      eventPrecision: ratio(both.length, predicted.length),
      eventRecall: ratio(both.length, actual.length),
      categoryAccuracy: ratio(both.filter((r) => categoryMatches(r.expect, r.got.category)).length, both.length),
    },
    severity: {
      compared: withSeverity.length,
      exact: ratio(withSeverity.filter((r) => r.got.severity === r.expect.severity).length, withSeverity.length),
      withinOne: ratio(withSeverity.filter((r) => Math.abs(r.got.severity! - r.expect.severity!) <= 1).length, withSeverity.length),
    },
    verifier: {
      attempts,
      passRate: ratio(passed, attempts),
      firstTryPassRate: ratio(firstTry, tried.length),
      templateFallbackRate: ratio(withCopy.filter((r) => r.copyTemplate).length, withCopy.length),
    },
    cost: { ...usage, eur, eurPerEvent: n ? eur / n : 0 },
    results,
  };
}

const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`);

/** Plain-text report for the terminal. */
export function formatReport(r: EvalReport, label = ''): string {
  const lines = [
    `Hey-Okay AI evaluation${label ? ` · ${label}` : ''} · ${r.mode === 'model' ? 'model' : 'rules only (no model configured)'} · ${r.cases} cases`,
    '',
    `Extraction accuracy      ${pct(r.extraction.accuracy)}   (alert or not, and the topic)`,
    `  alert precision        ${pct(r.extraction.eventPrecision)}`,
    `  alert recall           ${pct(r.extraction.eventRecall)}`,
    `  topic right            ${pct(r.extraction.categoryAccuracy)}   (of alerts found)`,
    `Severity agreement       ${pct(r.severity.exact)} exact, ${pct(r.severity.withinOne)} within one level   (${r.severity.compared} compared)`,
    `Verifier pass rate       ${pct(r.verifier.passRate)}   (${r.verifier.attempts} AI texts; first try ${pct(r.verifier.firstTryPassRate)}; template used ${pct(r.verifier.templateFallbackRate)})`,
    `Cost                     €${r.cost.eur.toFixed(4)} total, €${r.cost.eurPerEvent.toFixed(5)} per event   (${r.cost.calls} calls, ${r.cost.inputTokens} in / ${r.cost.outputTokens} out tokens)`,
  ];
  const wrong = r.results.filter((x) => !x.correct || (x.expect.isEvent && x.got.isEvent && x.got.severity !== x.expect.severity));
  if (wrong.length) {
    lines.push('', 'Disagreements:');
    for (const x of wrong) {
      const want = x.expect.isEvent ? `${[x.expect.category].flat().join('|')} sev ${x.expect.severity}` : 'no alert';
      const got = x.got.isEvent ? `${x.got.category} sev ${x.got.severity}` : 'no alert';
      lines.push(`  ${x.correct ? '~' : '✗'} ${x.set}/${x.id}: expected ${want}, got ${got}`);
    }
  }
  return lines.join('\n');
}
