import { M } from './metrics.js';

/**
 * Polls every source on its own, so one slow or broken source can't hold up the others.
 *
 * Before, all sources ran one after another in a single cycle guarded by one "running" flag: a
 * source that answered slowly delayed every source after it, and the cycle after that was
 * skipped entirely. Now each source has its own lock (a source still busy is skipped, the others
 * run), fetching happens in parallel, and only the pipeline step is serialised so two sources
 * never cluster into the store at the same moment.
 */

export interface SourceTask {
  /** e.g. "nina:dwd", "presseportal:polizei-hamburg", "nws:CA". */
  key: string;
  /** Fetch and ingest once. Returns the report for this source. */
  run: () => Promise<unknown>;
}

export interface SourceStatus {
  ok: boolean;
  running: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastDurationMs: number | null;
}

/** One holder at a time, in arrival order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

export class IngestScheduler {
  private readonly status = new Map<string, SourceStatus>();

  constructor(
    private readonly tasks: SourceTask[],
    private readonly onError: (key: string, err: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {
    for (const t of tasks) this.status.set(t.key, { ok: false, running: false, lastOkAt: null, lastErrorAt: null, lastDurationMs: null });
  }

  /** Starts every source that isn't still busy and waits for those. Busy ones report "still running". */
  async tick(): Promise<Record<string, unknown>> {
    const report: Record<string, unknown> = {};
    await Promise.all(this.tasks.map(async (t) => {
      const s = this.status.get(t.key)!;
      if (s.running) { report[t.key] = { skipped: 'still running' }; return; }
      s.running = true;
      const started = this.now();
      try {
        report[t.key] = await t.run();
        s.ok = true;
        s.lastOkAt = new Date(this.now()).toISOString();
        M.sourcePolls.inc({ source: t.key, result: 'ok' });
      } catch (err) {
        s.ok = false;
        s.lastErrorAt = new Date(this.now()).toISOString();
        M.sourcePolls.inc({ source: t.key, result: 'error' });
        this.onError(t.key, err);
        report[t.key] = { error: (err as Error)?.message ?? String(err) };
      } finally {
        s.lastDurationMs = this.now() - started;
        M.sourcePollSeconds.observe({ source: t.key }, s.lastDurationMs / 1000);
        s.running = false;
      }
    }));
    return report;
  }

  /** Per-source health, without error texts (safe for the public /health endpoint). */
  snapshot(): Record<string, SourceStatus> {
    return Object.fromEntries([...this.status].map(([k, v]) => [k, { ...v }]));
  }
}
