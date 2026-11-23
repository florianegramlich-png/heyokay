import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadCases, type EvalCase } from '../src/eval/cases.js';
import { categoryMatches, formatReport, runEval, type EvalReport } from '../src/eval/run.js';
import { formatComparison, suggestOrder } from '../src/eval/compare.js';
import { NoLLM, type LlmUsage, type StructuredLLM } from '../src/llm.js';

const root = join(import.meta.dirname, '..');
const CASES = join(root, 'eval', 'cases');
const FIXTURES = join(root, 'test', 'fixtures');

describe('eval cases', () => {
  const cases = loadCases(CASES, FIXTURES);

  it('loads the synthetic set (50) and the fixture set, every case valid', () => {
    expect(cases.filter((c) => c.set === 'synthetic-de')).toHaveLength(50);
    expect(cases.filter((c) => c.set === 'fixtures').length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      expect(c.item.title.length).toBeGreaterThan(0);
      if (c.expect.isEvent) expect(c.expect.severity).toBeGreaterThanOrEqual(1);
    }
  });

  it('covers alerts and non-alerts in every original topic', () => {
    const topics = new Set(cases.filter((c) => c.expect.isEvent).flatMap((c) => [c.expect.category].flat()));
    for (const t of ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure']) expect(topics).toContain(t);
    expect(cases.filter((c) => !c.expect.isEvent).length).toBeGreaterThanOrEqual(15);
  });

  it('resolves fixture cases from the saved feeds', () => {
    const ostkreuz = cases.find((c) => c.id === 'fx-berlin-ostkreuz')!;
    expect(ostkreuz.item.title).toMatch(/Ostkreuz/);
    expect(ostkreuz.item.category).toBe('crime');
    const hh = cases.find((c) => c.id === 'fx-hh-sulldorf-appeal')!;
    expect(hh.item.title).not.toMatch(/^POL-HH/);
    expect(hh.defaultArea?.name).toBe('Hamburg');
  });

  it('rejects broken files: an alert without severity, duplicate ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hok-eval-'));
    const item = { sourceName: 'X', title: 'Brand in Mitte', body: '', publishedAt: '2026-11-20T08:00:00Z' };
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ name: 'a', cases: [{ id: 'x', item, expect: { isEvent: true, category: 'public_safety' } }] }));
    expect(() => loadCases(dir, FIXTURES)).toThrow(/severity/);
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ name: 'a', cases: [{ id: 'x', item, expect: { isEvent: false } }, { id: 'x', item, expect: { isEvent: false } }] }));
    expect(() => loadCases(dir, FIXTURES)).toThrow(/duplicate/);
  });
});

describe('categoryMatches', () => {
  it('accepts any listed topic', () => {
    expect(categoryMatches({ isEvent: true, category: ['infrastructure', 'transit'], severity: 2 }, 'transit')).toBe(true);
    expect(categoryMatches({ isEvent: true, category: 'weather', severity: 2 }, 'transit')).toBe(false);
    expect(categoryMatches({ isEvent: false }, undefined)).toBe(false);
  });
});

/** A model that knows the labels: answers extraction from them; its first alert text invents a number. */
class OracleLLM implements StructuredLLM {
  readonly enabled = true;
  onUsage?: (u: LlmUsage) => void;
  private copyCalls = new Map<string, number>();
  constructor(private byTitle: Map<string, EvalCase>) {}
  async generate<T extends z.ZodType>(system: string, user: string): Promise<z.infer<T> | null> {
    this.onUsage?.({ inputTokens: 1000, outputTokens: 100 });
    if (system.startsWith('You extract')) {
      const c = [...this.byTitle.values()].find((x) => user.includes(x.item.title))!;
      const e = c.expect;
      return {
        isCurrentSafetyEvent: e.isEvent, category: [e.category ?? 'public_safety'].flat()[0], severity: e.severity ?? 1,
        confidence: 0.9, title: c.item.title, summary: c.item.body, place: '', radiusM: 1000, endsAt: null,
      } as z.infer<T>;
    }
    const facts = user.split('FACTS:\n')[1] ?? '';
    const key = facts.slice(0, 80);
    const n = (this.copyCalls.get(key) ?? 0) + 1;
    this.copyCalls.set(key, n);
    // First attempt: a number that isn't in the source → verifier rejects; second: grounded.
    return (n === 1 ? { title: 'Hinweis', body: 'Seit 99 Minuten' } : { title: 'Hinweis', body: 'Bitte die Hinweise beachten' }) as z.infer<T>;
  }
}

describe('runEval', () => {
  const cases = loadCases(CASES, FIXTURES);

  it('rules only: a baseline with no model calls and no cost', async () => {
    const r = await runEval(cases, { llm: new NoLLM(), priceInPerMTok: 1, priceOutPerMTok: 5 });
    expect(r.mode).toBe('rules');
    expect(r.cases).toBe(cases.length);
    expect(r.extraction.accuracy).toBeGreaterThan(0.3);
    expect(r.verifier.attempts).toBe(0);
    expect(r.verifier.templateFallbackRate).toBe(1);
    expect(r.cost.eur).toBe(0);
    expect(formatReport(r)).toMatch(/Extraction accuracy/);
  });

  it('scores a model: accuracy, severity, verifier pass rate and cost per event', async () => {
    const synthetic = cases.filter((c) => c.set === 'synthetic-de');
    const llm = new OracleLLM(new Map(synthetic.map((c) => [c.item.title, c])));
    const r = await runEval(synthetic, { llm, priceInPerMTok: 1, priceOutPerMTok: 5 });
    expect(r.mode).toBe('model');
    expect(r.extraction.accuracy).toBe(1);
    expect(r.extraction.eventPrecision).toBe(1);
    expect(r.extraction.eventRecall).toBe(1);
    expect(r.severity.compared).toBe(35);
    expect(r.severity.exact).toBe(1);
    // Every alert: one rejected attempt, one accepted.
    expect(r.verifier.attempts).toBe(70);
    expect(r.verifier.passRate).toBe(0.5);
    expect(r.verifier.firstTryPassRate).toBe(0);
    expect(r.verifier.templateFallbackRate).toBe(0);
    expect(r.results.find((x) => x.expect.isEvent)!.verifierProblems.join()).toMatch(/99/);
    // 50 extraction calls + 70 copy calls, each 1000 in / 100 out at €1 / €5 per million.
    expect(r.cost.calls).toBe(120);
    expect(r.cost.eur).toBeCloseTo(120 * (1000 * 1 + 100 * 5) / 1e6, 6);
    expect(r.cost.eurPerEvent).toBeCloseTo(r.cost.eur / 50, 8);
  });
});

describe('provider comparison', () => {
  const rep = (accuracy: number, eurPerEvent: number, o: { exact?: number; pass?: number; calls?: number } = {}) => ({
    mode: 'model', cases: 10,
    extraction: { accuracy, eventPrecision: accuracy, eventRecall: accuracy, categoryAccuracy: 1 },
    severity: { compared: 5, exact: o.exact ?? 0.6, withinOne: 1 },
    verifier: { attempts: 5, passRate: o.pass ?? 0.8, firstTryPassRate: 0.8, templateFallbackRate: 0 },
    cost: { calls: o.calls ?? 10, inputTokens: 1, outputTokens: 1, eur: eurPerEvent * 10, eurPerEvent },
    results: [],
  }) as EvalReport;
  const rules = rep(0.6, 0, { calls: 0 });

  it('best quality first; near-equal quality → cheaper first; worse than rules or silent → left out', () => {
    const s = suggestOrder([
      { name: 'anthropic', report: rep(0.92, 0.002) },
      { name: 'mistral', report: rep(0.91, 0.0005) },
      { name: 'openai_compat', report: rep(0.8, 0.0001) },
    ], rules);
    expect(s.order).toEqual(['mistral', 'anthropic', 'openai_compat']);
    const t = suggestOrder([
      { name: 'anthropic', report: rep(0.92, 0.002) },
      { name: 'openai_compat', report: rep(0.55, 0.0001) },
      { name: 'mistral', report: rep(0, 0, { calls: 0 }) },
    ], rules);
    expect(t.order).toEqual(['anthropic']);
    expect(t.dropped.map((d) => d.name)).toEqual(['openai_compat', 'mistral']);
    expect(t.dropped[1].reason).toMatch(/no answers/);
  });

  it('outside the tie, accuracy then severity decide', () => {
    const s = suggestOrder([
      { name: 'a', report: rep(0.8, 0.0001, { exact: 0.5 }) },
      { name: 'b', report: rep(0.8, 0.0001, { exact: 0.7 }) },
      { name: 'c', report: rep(0.95, 0.01) },
    ], rules);
    expect(s.order).toEqual(['c', 'b', 'a']);
  });

  it('prints a table with the baseline and the suggestion', () => {
    const text = formatComparison([{ name: 'anthropic', report: rep(0.92, 0.002) }], rules);
    expect(text).toMatch(/anthropic\s+92%/);
    expect(text).toMatch(/rules \(baseline\)\s+60%/);
    expect(text).toMatch(/Suggested: LLM_PROVIDERS=anthropic/);
    expect(formatComparison([], rules)).toMatch(/No provider to compare/);
  });
});
