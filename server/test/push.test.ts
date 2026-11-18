import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExpoPushSender, MemoryPushSender, toExpoMessage } from '../src/push.js';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { Pipeline } from '../src/pipeline/run.js';
import type { Alert } from '../src/types.js';

const alert = (o: Partial<Alert> = {}): Alert => ({
  id: 'a1', userId: 'u1', eventId: 'e1', eventRevision: 1, title: 'Sturmböen', body: 'Bis 20 Uhr.', action: 'Drinnen bleiben.',
  category: 'weather', severity: 3, official: true, aiWritten: false, sourceName: 'DWD', sourceUrl: null,
  lat: 52.5, lon: 13.4, radiusM: 1000, matchedPlace: null, delivery: 'push', reason: 'relevant', kind: 'new',
  feedback: null, createdAt: '2026-11-18T10:00:00Z', ...o,
});

function fakeFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; body: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = responses.shift()!;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Expo push sender', () => {
  it('adds the rating buttons (category) and groups by event, except on all-clears', () => {
    expect(toExpoMessage({ token: 'T', alert: alert() })).toMatchObject({ to: 'T', categoryId: 'alert', threadId: 'e1', data: { alertId: 'a1', eventId: 'e1' } });
    expect(toExpoMessage({ token: 'T', alert: alert({ kind: 'all_clear' }) })).toMatchObject({ threadId: 'e1' });
    expect(toExpoMessage({ token: 'T', alert: alert({ kind: 'all_clear' }) })).not.toHaveProperty('categoryId');
  });

  it('retries 5xx and network errors with backoff, then maps tickets per message', async () => {
    const { f, calls } = fakeFetch([
      { status: 503 }, new Error('socket hang up'),
      { status: 200, body: { data: [{ status: 'ok', id: 'tk1' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] } },
    ]);
    const waits: number[] = [];
    const sender = new ExpoPushSender('https://push.test/send', { fetch: f, sleep: async (ms) => { waits.push(ms); }, accessToken: 'xat' });
    const r = await sender.send([{ token: 'A', alert: alert() }, { token: 'B', alert: alert({ id: 'a2' }) }]);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    expect(r).toMatchObject({ sent: 1, errors: 1 });
    expect(r.tickets).toEqual([
      { alertId: 'a1', userId: 'u1', token: 'A', ticketId: 'tk1', status: 'pending', error: null },
      { alertId: 'a2', userId: 'u1', token: 'B', ticketId: null, status: 'error', error: 'DeviceNotRegistered' },
    ]);
  });

  it('does not retry a 4xx; gives up after the last attempt', async () => {
    const bad = fakeFetch([{ status: 400 }]);
    const r = await new ExpoPushSender('https://push.test/send', { fetch: bad.f, sleep: async () => {} }).send([{ token: 'A', alert: alert() }]);
    expect(bad.calls).toHaveLength(1);
    expect(r.tickets[0]).toMatchObject({ status: 'error', error: 'SendFailed' });
    const down = fakeFetch([{ status: 502 }, { status: 502 }, { status: 502 }]);
    await new ExpoPushSender('https://push.test/send', { fetch: down.f, sleep: async () => {} }).send([{ token: 'A', alert: alert() }]);
    expect(down.calls).toHaveLength(3);
  });

  it('fetches receipts from the getReceipts endpoint', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { data: { tk1: { status: 'ok' }, tk2: { status: 'error', details: { error: 'MessageRateExceeded' } } } } }]);
    const r = await new ExpoPushSender('https://push.test/--/api/v2/push/send', { fetch: f }).getReceipts(['tk1', 'tk2', 'tk3']);
    expect(calls[0]).toEqual({ url: 'https://push.test/--/api/v2/push/getReceipts', body: { ids: ['tk1', 'tk2', 'tk3'] } });
    expect([...r]).toEqual([['tk1', { status: 'ok' }], ['tk2', { status: 'error', error: 'MessageRateExceeded' }]]);
  });
});

describe.each(storeBackends())('push receipts in the pipeline ($name)', (backend) => {
  let store: Store, push: MemoryPushSender, pipeline: Pipeline;
  let clock = new Date('2026-11-18T12:00:00+01:00');
  const later = (min: number) => { clock = new Date(clock.getTime() + min * 60_000); };
  beforeEach(async () => {
    clock = new Date('2026-11-18T12:00:00+01:00');
    store = await backend.make();
    push = new MemoryPushSender();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, now: () => clock, config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 } });
  });
  afterEach(async () => { await store.close(); });

  async function userWith(token: string) {
    const { user } = await store.createUser(token, { quietHours: null });
    await store.updateLocation(user.id, 52.503, 13.469);
    return user;
  }
  const manual = (title: string) => pipeline.manualAlert({
    category: 'transit', severity: 4, title, body: 'Zwischen Ostkreuz und Lichtenberg fahren keine S-Bahnen.',
    sourceName: 'Hey-Okay Redaktion', lat: 52.503, lon: 13.469, radiusM: 1000, areaName: 'Ostkreuz',
  });

  it('delivered receipts are recorded; uninstalled apps lose their token; transient errors are resent once more', async () => {
    const ok = await userWith('ExponentPushToken[ok]');
    const gone = await userWith('ExponentPushToken[gone]');
    const busy = await userWith('ExponentPushToken[busy]');
    await manual('S5 unterbrochen');
    expect(push.outbox).toHaveLength(3);

    // Too early: receipts are checked 15 minutes after sending.
    expect((await pipeline.checkPushReceipts()).checked).toBe(0);

    later(16);
    const ids = new Map(push.outbox.map((m, i) => [m.token, `t${i + 1}`]));
    push.receipts.set(ids.get('ExponentPushToken[ok]')!, { status: 'ok' });
    push.receipts.set(ids.get('ExponentPushToken[gone]')!, { status: 'error', error: 'DeviceNotRegistered' });
    push.receipts.set(ids.get('ExponentPushToken[busy]')!, { status: 'error', error: 'MessageRateExceeded' });
    const r = await pipeline.checkPushReceipts();
    expect(r).toMatchObject({ checked: 3, delivered: 1, resent: 1, tokensCleared: 1 });
    expect((await store.getUser(gone.id))?.pushToken).toBeNull();
    expect((await store.getUser(ok.id))?.pushToken).toBe('ExponentPushToken[ok]');
    expect(push.outbox.at(-1)?.token).toBe('ExponentPushToken[busy]'); // resent

    // The resend fails again and again: at most two resends, then it's recorded as failed.
    for (let i = 0; i < 3; i++) {
      later(16);
      const last = `t${push.outbox.length}`;
      push.receipts.set(last, { status: 'error', error: 'MessageRateExceeded' });
      await pipeline.checkPushReceipts();
    }
    expect(push.outbox.filter((m) => m.token === 'ExponentPushToken[busy]')).toHaveLength(3); // first send + 2 resends
    const m = await store.metrics('2000-01-01T00:00:00Z');
    expect(m.pushDelivery).toMatchObject({ delivered: 1, failed: 2, pending: 0 });
    expect((await store.getUser(busy.id))?.pushToken).toBe('ExponentPushToken[busy]');
  });

  it('a device refused at send time loses its token at once; missing receipts become unknown after a day', async () => {
    const gone = await userWith('ExponentPushToken[old]');
    await userWith('ExponentPushToken[quiet]');
    push.refuse.set('ExponentPushToken[old]', 'DeviceNotRegistered');
    await manual('S5 unterbrochen');
    expect((await store.getUser(gone.id))?.pushToken).toBeNull();

    later(25 * 60);
    expect((await pipeline.checkPushReceipts()).unknown).toBe(1); // Expo never returned the receipt
    expect((await pipeline.checkPushReceipts()).unknown).toBe(0);
  });

  it('GDPR delete also removes push records', async () => {
    const u = await userWith('ExponentPushToken[x]');
    await manual('S5 unterbrochen');
    await store.deleteUser(u.id);
    later(16);
    expect((await pipeline.checkPushReceipts()).checked).toBe(0);
  });
});
