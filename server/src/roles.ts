import type { Store } from './store.js';

/**
 * Process roles, so the server can run on several machines (docs/ARCHITECTURE.md §8, step 2).
 *
 *   api    — answers HTTP only. Stateless: add as many as traffic needs.
 *   worker — polls sources, runs the pipeline, sends pushes and checks receipts. No public HTTP
 *            routes except /health.
 *   all    — both, the default: one machine does everything (today's setup).
 *
 * Several workers may run (for failover), but only the one holding the "worker" lease does the
 * work. It renews the lease every tick; if it dies, another worker takes over once the lease
 * runs out. So an alert is never fetched, matched or pushed twice by two machines.
 */
export type Role = 'api' | 'worker' | 'all';

export function parseRole(raw: string | undefined): Role {
  const r = (raw ?? 'all').trim().toLowerCase();
  if (r === 'api' || r === 'worker' || r === 'all') return r;
  throw new Error(`ROLE must be api, worker or all (got "${raw}")`);
}

export const runsWorker = (role: Role) => role !== 'api';
export const runsApi = (role: Role) => role !== 'worker';

export const WORKER_LEASE = 'worker';

/** Long enough to survive a slow tick, short enough for a quick takeover. */
export function leaseTtlMs(pollIntervalSec: number) {
  return Math.max(60_000, pollIntervalSec * 1000 * 3);
}

export class LeaderElector {
  private leading = false;
  private since: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly holder: string,
    private readonly ttlMs: number,
    private readonly name = WORKER_LEASE,
    private readonly onChange: (leading: boolean) => void = () => {},
  ) {}

  /** Takes or renews the lease. Call before each unit of work; do the work only when true. */
  async check(now = new Date()): Promise<boolean> {
    let ok: boolean;
    try {
      ok = await this.store.acquireLease(this.name, this.holder, this.ttlMs, now);
    } catch {
      ok = false; // database unreachable: stand down rather than risk a second worker
    }
    if (ok !== this.leading) {
      this.leading = ok;
      this.since = ok ? now.toISOString() : null;
      this.onChange(ok);
    }
    return ok;
  }

  async release() {
    if (!this.leading) return;
    this.leading = false;
    this.since = null;
    await this.store.releaseLease(this.name, this.holder).catch(() => {});
  }

  status() {
    return { leading: this.leading, since: this.since };
  }
}
