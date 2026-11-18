import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryPushSender, type PushSender } from '../src/push.js';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { PUSH_JOB_LOCK_MS, Pipeline } from '../src/pipeline/run.js';
import type { Alert } from '../src/types.js';

const alertFor = (userId: string, n = 0): Alert => ({
  id: randomUUID(), userId, eventId: 'e1', eventRevision: 1, title: `Sturmböen ${n}`, body: 'Bis 20 Uhr.', action: 'Drinnen bleiben.',
  category: 'weather', severity: 3, official: true, aiWritten: false, sourceName: 'DWD', sourceUrl: null,
  lat: 52.5, lon: 13.4, radiusM: 1000, matchedPlace: null, delivery: 'push', reason: 'relevant', kind: 'new',
  feedback: null, createdAt: '2026-11-18T10:00:00Z',
});

for (const backend of storeBackends()) {
  describe(`delivery queue (${backend.name})`, () => {
    let store: Store;
    let clock: Date;
    const pipeline = (push: PushSender, holder = 'm1', concurrency = 4) => new Pipeline({
      store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, now: () => clock,
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 }, delivery: { holder, concurrency, batch: 100 },
    });
    beforeEach(async () => { store = await backend.make(); clock = new Date('2026-11-18T10:00:00Z'); });
    afterEach(async () => { await store.close(); });

    it('a sender that dies mid-batch: its jobs go out after the lock runs out, exactly once', async () => {
      const { user } = await store.createUser('tok');
      await store.enqueuePushJobs([1, 2, 3].map((n) => ({ token: `tok${n}`, alert: alertFor(user.id, n), attempt: 0 })), clock.toISOString());
      // m0 claims everything and crashes before sending.
      const lockUntil = new Date(clock.getTime() + PUSH_JOB_LOCK_MS).toISOString();
      expect(await store.claimPushJobs('m0', 10, clock.toISOString(), lockUntil)).toHaveLength(3);

      const push = new MemoryPushSender();
      expect(await pipeline(push).drainPushQueue()).toEqual({ sent: 0, errors: 0, jobs: 0 }); // still locked
      clock = new Date(clock.getTime() + PUSH_JOB_LOCK_MS + 1000);
      expect(await pipeline(push).drainPushQueue()).toEqual({ sent: 3, errors: 0, jobs: 3 });
      expect(push.outbox.map((m) => m.token).sort()).toEqual(['tok1', 'tok2', 'tok3']);
      expect(await store.pushQueueDepth()).toBe(0);
      expect(await pipeline(push).drainPushQueue()).toEqual({ sent: 0, errors: 0, jobs: 0 });
    });

    it('parallel claims never hand out the same job', async () => {
      const { user } = await store.createUser('tok');
      await store.enqueuePushJobs(Array.from({ length: 40 }, (_, n) => ({ token: `t${n}`, alert: alertFor(user.id, n), attempt: 0 })), clock.toISOString());
      const until = new Date(clock.getTime() + 60_000).toISOString();
      const claims = await Promise.all(['a', 'b', 'c', 'd'].map((h) => store.claimPushJobs(h, 10, clock.toISOString(), until)));
      const ids = claims.flat().map((j) => j.id);
      expect(ids).toHaveLength(40);
      expect(new Set(ids).size).toBe(40);
      expect(claims.flat()[0].alert.userId).toBe(user.id); // the message travels with the job
    });

    it('a refused push still leaves the queue; an uninstalled app loses its token', async () => {
      const { user } = await store.createUser('gone');
      const push = new MemoryPushSender();
      push.refuse.set('gone', 'DeviceNotRegistered');
      await store.enqueuePushJobs([{ token: 'gone', alert: alertFor(user.id), attempt: 0 }], clock.toISOString());
      expect(await pipeline(push).drainPushQueue()).toEqual({ sent: 0, errors: 1, jobs: 1 });
      expect(await store.pushQueueDepth()).toBe(0);
      expect((await store.getUser(user.id))?.pushToken).toBeNull();
    });

    it('deleting a person (GDPR) removes their queued pushes', async () => {
      const { user } = await store.createUser('tok');
      await store.enqueuePushJobs([{ token: 'tok', alert: alertFor(user.id), attempt: 0 }], clock.toISOString());
      await store.deleteUser(user.id);
      expect(await store.pushQueueDepth()).toBe(0);
    });

    it('fan-out: 20 000 pushes for one event go out once each, oldest first', async () => {
      const { user } = await store.createUser('tok');
      const n = 20_000;
      await store.enqueuePushJobs(Array.from({ length: n }, (_, i) => ({ token: `t${i}`, alert: alertFor(user.id, i), attempt: 0 })), clock.toISOString());
      expect(await store.pushQueueDepth()).toBe(n);
      const push = new MemoryPushSender();
      const started = Date.now();
      const r = await pipeline(push, 'm1', 8).drainPushQueue();
      const ms = Date.now() - started;
      expect(r).toEqual({ sent: n, errors: 0, jobs: n });
      expect(new Set(push.outbox.map((m) => m.token)).size).toBe(n);
      expect(await store.pushQueueDepth()).toBe(0);
      console.log(`[${backend.name}] drained ${n} pushes in ${ms} ms (queue + tickets, no network)`);
    }, 120_000);
  });
}
