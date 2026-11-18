import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LlmUsage, StructuredLLM } from '../src/llm.js';
import { BudgetedLLM, utcDay } from '../src/llm-budget.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';
import { setErrorSinks, stderrSink, type ErrorLogEntry } from '../src/errors.js';

/** A fake model: every call uses 100k input + 20k output tokens. */
class FakeLLM implements StructuredLLM {
  readonly enabled = true;
  calls = 0;
  onUsage?: (u: LlmUsage) => void;
  async generate<T extends z.ZodType>(_s: string, _u: string, _schema: T): Promise<z.infer<T> | null> {
    this.calls++;
    this.onUsage?.({ inputTokens: 100_000, outputTokens: 20_000 });
    return { ok: true } as z.infer<T>;
  }
}
const schema = z.object({ ok: z.boolean() });

for (const backend of storeBackends()) {
  describe(`AI cost guard (${backend.name})`, () => {
    let store: Store;
    afterEach(async () => { setErrorSinks(stderrSink); await store.close(); });

    it('prices each call, stops at the daily budget (template fallback), warns once at 80%, resets the next day', async () => {
      store = await backend.make();
      const logged: ErrorLogEntry[] = [];
      setErrorSinks((e) => logged.push(e));
      let now = new Date('2026-11-18T10:00:00Z');
      const inner = new FakeLLM();
      // €1/M in, €5/M out → each call = 0.1 + 0.1 = €0.20; budget €0.50 → calls 1–3 run, then stop.
      const llm = new BudgetedLLM(inner, store, { dailyBudgetEur: 0.5, priceInPerMTok: 1, priceOutPerMTok: 5 }, () => now);
      const results = [];
      for (let i = 0; i < 5; i++) { results.push(await llm.generate('s', 'u', schema)); }
      expect(results.map((r) => r !== null)).toEqual([true, true, true, false, false]);
      expect(inner.calls).toBe(3);
      expect(await llm.spent()).toBeCloseTo(0.6, 5);
      const [day] = await store.llmUsage('2026-11-18');
      expect(day).toMatchObject({ day: '2026-11-18', calls: 3, inputTokens: 300_000, outputTokens: 60_000, skipped: 2 });
      expect(day.eur).toBeCloseTo(0.6, 5);
      expect(logged.filter((e) => e.context === 'llm-budget')).toHaveLength(1); // one warning, at 80%
      expect(logged[0].message).toContain('80%');

      now = new Date('2026-11-19T00:05:00Z');
      expect(await llm.generate('s', 'u', schema)).not.toBeNull(); // new day, new budget
      expect(utcDay(now)).toBe('2026-11-19');
    });

    it('another machine starting later sees the spend so far', async () => {
      store = await backend.make();
      const now = () => new Date('2026-11-18T12:00:00Z');
      await store.addLlmUsage('2026-11-18', { calls: 10, inputTokens: 1, outputTokens: 1, eur: 0.49, skipped: 0 });
      const llm = new BudgetedLLM(new FakeLLM(), store, { dailyBudgetEur: 0.5, priceInPerMTok: 1, priceOutPerMTok: 5 }, now);
      expect(await llm.generate('s', 'u', schema)).not.toBeNull(); // 0.49 < 0.5
      expect(await llm.generate('s', 'u', schema)).toBeNull(); // 0.69 ≥ 0.5
    });

    it('budget 0 = no cap; a disabled model is never called', async () => {
      store = await backend.make();
      const inner = new FakeLLM();
      const llm = new BudgetedLLM(inner, store, { dailyBudgetEur: 0, priceInPerMTok: 1, priceOutPerMTok: 5 });
      for (let i = 0; i < 4; i++) expect(await llm.generate('s', 'u', schema)).not.toBeNull();
      const off = new BudgetedLLM({ enabled: false, generate: async () => { throw new Error('called'); } }, store, { dailyBudgetEur: 1, priceInPerMTok: 1, priceOutPerMTok: 1 });
      expect(await off.generate('s', 'u', schema)).toBeNull();
    });
  });
}
