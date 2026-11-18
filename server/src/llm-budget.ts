import type { z } from 'zod';
import type { LlmUsage, StructuredLLM } from './llm.js';
import type { Store } from './store.js';
import { logError } from './errors.js';
import { M } from './metrics.js';

/**
 * AI cost guard (PRD v6.5 §6.6). Every model call is priced and added to today's spend in the
 * database (shared by all machines). Once the daily budget is used up, calls are skipped and the
 * pipeline uses its rules and templates, which already work without AI, so alerts keep flowing.
 * At 80% one warning goes to the error log (and Sentry), once per day.
 *
 * Prices are per million tokens in EUR (`LLM_PRICE_IN_EUR_PER_MTOK`, `LLM_PRICE_OUT_EUR_PER_MTOK`).
 * Set them to the contract price of the model in use; the defaults are deliberately on the high
 * side, so the guard errs towards saving money.
 */
export interface BudgetConfig {
  /** 0 = no cap. */
  dailyBudgetEur: number;
  priceInPerMTok: number;
  priceOutPerMTok: number;
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export class BudgetedLLM implements StructuredLLM {
  private spentToday = 0;
  private day = '';
  private warnedDay = '';
  private loaded: Promise<void> | null = null;
  /** Usage records in flight, in order; generate() waits for them so the spend is current. */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: StructuredLLM & { onUsage?: (u: LlmUsage) => void },
    private readonly store: Store,
    private readonly cfg: BudgetConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    inner.onUsage = (u) => { this.pending = this.pending.then(() => this.record(u)); };
  }

  get enabled() {
    return this.inner.enabled;
  }

  /** Today's spend as known to this machine (refreshed from the database at day change). */
  async spent(): Promise<number> {
    await this.sync();
    return this.spentToday;
  }

  private async sync() {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.spentToday = 0;
      this.loaded = this.store.llmUsage(today).then((rows) => { this.spentToday = rows.find((r) => r.day === today)?.eur ?? 0; }).catch(() => {});
    }
    await this.loaded;
  }

  async generate<T extends z.ZodType>(system: string, user: string, schema: T): Promise<z.infer<T> | null> {
    if (!this.inner.enabled) return null;
    await this.sync();
    if (this.cfg.dailyBudgetEur > 0 && this.spentToday >= this.cfg.dailyBudgetEur) {
      M.llmCalls.inc({ result: 'over_budget' });
      await this.store.addLlmUsage(this.day, { calls: 0, inputTokens: 0, outputTokens: 0, eur: 0, skipped: 1 }).catch(() => {});
      return null; // template fallback
    }
    const out = await this.inner.generate(system, user, schema);
    await this.pending;
    M.llmCalls.inc({ result: out ? 'ok' : 'failed' });
    return out;
  }

  private async record(u: LlmUsage) {
    const eur = (u.inputTokens * this.cfg.priceInPerMTok + u.outputTokens * this.cfg.priceOutPerMTok) / 1_000_000;
    await this.sync();
    this.spentToday += eur;
    M.llmSpendToday.set({}, Math.round(this.spentToday * 10_000) / 10_000);
    await this.store.addLlmUsage(this.day, { calls: 1, inputTokens: u.inputTokens, outputTokens: u.outputTokens, eur, skipped: 0 }).catch((e) => logError('llm-budget', e));
    const b = this.cfg.dailyBudgetEur;
    if (b > 0 && this.spentToday >= 0.8 * b && this.warnedDay !== this.day) {
      this.warnedDay = this.day;
      logError('llm-budget', new Error(`AI spend today is €${this.spentToday.toFixed(2)} of the €${b.toFixed(2)} daily budget (80% reached). Above 100% alerts use templates.`));
    }
  }
}
