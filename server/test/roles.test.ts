import { afterEach, describe, expect, it } from 'vitest';
import { storeBackends } from './backends.js';
import { LeaderElector, leaseTtlMs, parseRole, runsApi, runsWorker } from '../src/roles.js';
import type { Store } from '../src/store.js';

describe('roles', () => {
  it('parses ROLE, default all', () => {
    expect(parseRole(undefined)).toBe('all');
    expect(parseRole(' Worker ')).toBe('worker');
    expect(() => parseRole('boss')).toThrow();
    expect(runsApi('worker')).toBe(false);
    expect(runsWorker('api')).toBe(false);
    expect(runsApi('all') && runsWorker('all')).toBe(true);
  });

  it('lease outlives a few polls', () => {
    expect(leaseTtlMs(120)).toBe(360_000);
    expect(leaseTtlMs(5)).toBe(60_000);
  });
});

for (const backend of storeBackends()) {
  describe(`worker lease (${backend.name})`, () => {
    let store: Store;
    afterEach(async () => { await store?.close(); });

    it('only one worker leads; the other takes over when the lease runs out', async () => {
      store = await backend.make();
      const t0 = new Date('2026-11-18T10:00:00Z');
      const at = (s: number) => new Date(t0.getTime() + s * 1000);
      const a = new LeaderElector(store, 'machine-a', 60_000);
      const b = new LeaderElector(store, 'machine-b', 60_000);

      expect(await a.check(t0)).toBe(true);
      expect(await b.check(t0)).toBe(false);
      expect(await a.check(at(30))).toBe(true); // renews until 90 s
      expect(await b.check(at(80))).toBe(false);
      // a stops renewing (crashed); after the lease ends, b takes over and a stands down
      expect(await b.check(at(91))).toBe(true);
      expect(await a.check(at(95))).toBe(false);
      expect(a.status().leading).toBe(false);
      expect(b.status()).toEqual({ leading: true, since: at(91).toISOString() });
    });

    it('a clean shutdown hands over at once', async () => {
      store = await backend.make();
      const t0 = new Date('2026-11-18T10:00:00Z');
      const a = new LeaderElector(store, 'a', 60_000);
      const b = new LeaderElector(store, 'b', 60_000);
      expect(await a.check(t0)).toBe(true);
      await a.release();
      expect(await b.check(t0)).toBe(true);
    });

    it('many workers racing for a free lease: exactly one wins', async () => {
      store = await backend.make();
      const now = new Date('2026-11-18T10:00:00Z');
      const electors = Array.from({ length: 8 }, (_, i) => new LeaderElector(store, `m${i}`, 60_000));
      const wins = await Promise.all(electors.map((e) => e.check(now)));
      expect(wins.filter(Boolean)).toHaveLength(1);
    });

    it('a database error means standing down', async () => {
      store = await backend.make();
      const broken = { ...store, acquireLease: async () => { throw new Error('db down'); } } as unknown as Store;
      const changes: boolean[] = [];
      const e = new LeaderElector(broken, 'x', 60_000, 'worker', (l) => changes.push(l));
      expect(await e.check()).toBe(false);
      expect(changes).toEqual([]);
    });
  });
}
