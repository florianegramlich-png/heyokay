import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { digestDue, digestItems, digestPush, localClock } from '../src/pipeline/digest.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';
import type { Alert } from '../src/types.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { buildApi } from '../src/api.js';

// PRD 6.1 #7, 6.2 step 7: what went to the feed only comes as one calm push at the person's time.

const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
const OSTKREUZ = { lat: 52.5031, lon: 13.4691 };

const alert = (o: Partial<Alert>): Alert => ({
  id: 'a', userId: 'u', eventId: 'e', eventRevision: 1, title: 'T', body: 'B', action: '', category: 'transit', severity: 2,
  official: false, aiWritten: false, sourceName: 'S', sourceUrl: null, lat: 0, lon: 0, radiusM: 1, matchedPlace: null,
  delivery: 'feed', reason: 'daily limit reached', kind: 'new', feedback: null, createdAt: '2026-11-19T10:00:00.000Z', ...o,
});

describe('evening summary: timing and text', () => {
  it('is due from the chosen local time for three hours, then waits for tomorrow; off when null', () => {
    const berlin = { digestTime: '18:00', timezone: 'Europe/Berlin' };
    expect(digestDue(berlin, new Date('2026-11-19T18:05:00+01:00'))).toBe('2026-11-19');
    expect(digestDue(berlin, new Date('2026-11-19T17:59:00+01:00'))).toBeNull();
    expect(digestDue(berlin, new Date('2026-11-19T20:59:00+01:00'))).toBe('2026-11-19');
    expect(digestDue(berlin, new Date('2026-11-19T21:00:00+01:00'))).toBeNull();
    expect(digestDue({ ...berlin, digestTime: null }, new Date('2026-11-19T18:05:00+01:00'))).toBeNull();
    // Their own time zone decides: 18:05 in California is the next UTC day.
    expect(digestDue({ digestTime: '18:00', timezone: 'America/Los_Angeles' }, new Date('2026-11-20T02:05:00Z'))).toBe('2026-11-19');
    expect(localClock(new Date('2026-11-19T23:30:00Z'), 'Asia/Kolkata')).toEqual({ day: '2026-11-20', minutes: 5 * 60 });
    // A broken time zone falls back to Berlin instead of failing the whole run.
    expect(digestDue({ digestTime: '18:00', timezone: 'Nowhere/Else' }, new Date('2026-11-19T18:05:00+01:00'))).toBe('2026-11-19');
  });

  it('takes feed-only first alerts from the last day, most serious first, one per event, still running', () => {
    const now = new Date('2026-11-19T18:05:00+01:00');
    const items = digestItems([
      alert({ id: '1', eventId: 'e1', severity: 1, title: 'Info', createdAt: '2026-11-19T09:00:00Z' }),
      alert({ id: '2', eventId: 'e2', severity: 3, title: 'Wind', createdAt: '2026-11-19T08:00:00Z' }),
      alert({ id: '3', eventId: 'e3', delivery: 'push', title: 'Pushed already' }),
      alert({ id: '4', eventId: 'e4', kind: 'all_clear', title: 'Over' }),
      alert({ id: '5', eventId: 'e5', title: 'Yesterday', createdAt: '2026-11-18T10:00:00Z' }),
      alert({ id: '6', eventId: 'e6', title: 'Ended' }),
      alert({ id: '7', eventId: 'e2', severity: 3, title: 'Wind again', createdAt: '2026-11-19T07:00:00Z' }),
    ], now, (id) => id !== 'e6');
    expect(items.map((a) => a.title)).toEqual(['Wind', 'Info']);
  });

  it('one gentle push in the person’s language; tapping opens the most serious item', () => {
    const items = [alert({ id: 'x', title: 'S-Bahn Ostkreuz gesperrt', severity: 3 }), alert({ id: 'y', title: 'Erhöhter Wasserstand: Spree bei Berlin' })];
    const de = digestPush(items, 'de');
    expect(de).toMatchObject({ id: 'x', title: 'Dein Tagesüberblick: 2 Hinweise', body: 'S-Bahn Ostkreuz gesperrt · Erhöhter Wasserstand: Spree bei Berlin', severity: 1, delivery: 'push', reason: 'digest' });
    expect(digestPush(items.slice(0, 1), 'en').title).toBe('Your day: 1 update');
    const many = digestPush(Array.from({ length: 8 }, (_, i) => alert({ title: `Something quite long number ${i}` })), 'en');
    expect(many.body.length).toBeLessThanOrEqual(100);
    expect(many.body.endsWith('…')).toBe(true);
  });
});

describe.each(storeBackends())('evening summary through the pipeline ($name)', (backend) => {
  let store: Store, push: MemoryPushSender, pipeline: Pipeline, clock: Date;
  const user = async (prefs = {}) => {
    const { user } = await store.createUser('ExponentPushToken[d]', { language: 'en', timezone: 'Europe/Berlin', quietHours: null, dailyLimit: 1, ...prefs });
    await store.updateLocation(user.id, OSTKREUZ.lat, OSTKREUZ.lon);
    return user;
  };
  const curated = (title: string, severity: 1 | 2 | 3) => pipeline.manualAlert({
    category: 'transit', severity, title, body: 'Details.', sourceName: 'Hey-Okay Redaktion',
    lat: OSTKREUZ.lat, lon: OSTKREUZ.lon, radiusM: 1500, areaName: 'Berlin-Friedrichshain',
  });

  beforeEach(async () => {
    clock = new Date('2026-11-19T12:00:00+01:00');
    store = await backend.make();
    push = new MemoryPushSender();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: cfg, now: () => clock });
  });
  afterEach(async () => { await store.close(); });

  it('bundles what stayed in the feed into one push at 18:00, once; nothing to say → no push', async () => {
    const u = await user();
    const off = await user({ digestTime: null });
    await curated('Tram M10 diverted', 2); // pushed (first of the day)
    await curated('U5 delays', 2); // daily limit reached → feed
    const ended = await curated('Lift out of order', 1); // information → feed, then ends
    await curated('Street festival Saturday', 1); // information → feed
    clock = new Date('2026-11-19T15:00:00+01:00');
    await pipeline.endEvent(ended.eventId);
    expect(push.outbox).toHaveLength(2); // the first push to each person

    clock = new Date('2026-11-19T17:30:00+01:00');
    expect((await pipeline.sendDigests()).sent).toBe(0); // not yet

    clock = new Date('2026-11-19T18:02:00+01:00');
    const before = push.outbox.length;
    const r = await pipeline.sendDigests();
    expect(r).toMatchObject({ due: 1, sent: 1, pushes: 1 });
    const [msg] = push.outbox.slice(before);
    expect(msg.alert).toMatchObject({ title: 'Your day: 2 updates', body: 'U5 delays · Street festival Saturday', userId: u.id });
    expect(msg.alert.userId).not.toBe(off.id);
    // The summary doesn't use up tomorrow's daily limit, and it doesn't go out twice.
    expect(await store.pushCountSince(u.id, '2026-11-19T17:00:00Z')).toBe(0);
    clock = new Date('2026-11-19T18:10:00+01:00');
    expect((await pipeline.sendDigests()).sent).toBe(0);
    expect(push.outbox).toHaveLength(before + 1);
  });

  it('the time is a setting: validated by the API, saved, and used', async () => {
    const reg = await store.createUser('ExponentPushToken[s]', { timezone: 'Europe/Berlin' });
    const app = buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock });
    const put = (body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: { authorization: `Bearer ${reg.token}` }, payload: body });
    expect((await put({ digestTime: '25:00' })).statusCode).toBe(400);
    expect((await put({ digestTime: '20:30' })).statusCode).toBeLessThan(300);
    expect((await store.getUser(reg.user.id))!.prefs.digestTime).toBe('20:30');
    expect((await put({ digestTime: null })).statusCode).toBeLessThan(300);
    expect((await store.getUser(reg.user.id))!.prefs.digestTime).toBeNull();
    // New people get the default: 18:00.
    expect((await user()).prefs.digestTime).toBe('18:00');
  });
});
