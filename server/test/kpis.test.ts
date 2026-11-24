import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { KpiInputs, Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { computeKpis, type Kpi } from '../src/kpis.js';
import type { SourceItem } from '../src/types.js';

// PRD 13: the launch KPIs and their red lines, from the server's own data.

const NOW = new Date('2026-11-23T12:00:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const byKey = (k: Kpi[]) => Object.fromEntries(k.map((x) => [x.key, x]));

describe('computeKpis', () => {
  const alert = (o: Partial<KpiInputs['alerts'][number]>) => ({
    eventId: 'e1', userId: 'u1', kind: 'new', delivery: 'push', feedback: null, official: false,
    createdAt: ago(10), openedAt: null, eventStartsAt: ago(10.05), ...o,
  });

  it('computes every KPI and flags red lines', () => {
    const input: KpiInputs = {
      alerts: [
        alert({ openedAt: ago(9), feedback: 'relevant' }),
        alert({ userId: 'u2', feedback: 'relevant', official: true, eventStartsAt: ago(10.5) }),
        alert({ userId: 'u3', eventId: 'e2', delivery: 'feed', feedback: 'not_relevant' }),
        alert({ userId: 'u3', eventId: 'e2', kind: 'update', delivery: 'feed' }), // updates don't count
        alert({ userId: 'u4', delivery: 'suppressed' }), // nor suppressed ones
      ],
      users: [
        { createdAt: ago(24 * 10), lastSeenAt: ago(24 * 1), hasPush: true }, // retained
        { createdAt: ago(24 * 10), lastSeenAt: ago(24 * 9), hasPush: false }, // gone after a day
        { createdAt: ago(24 * 2), lastSeenAt: ago(1), hasPush: true }, // too new for D7
        { createdAt: ago(24 * 60), lastSeenAt: null, hasPush: true }, // too old for this cohort
      ],
    };
    const k = byKey(computeKpis(input, { sinceIso: ago(24 * 7), now: NOW, falseAlertEvents: new Set(['e2']) }));
    expect(k.pushOptIn).toMatchObject({ value: 0.75, red: false, basedOn: 4 });
    expect(k.d7Retention).toMatchObject({ value: 0.5, basedOn: 2, red: false });
    expect(k.openRate).toMatchObject({ value: 0.5, basedOn: 2, red: false });
    expect(k.relevantRate.value).toBeCloseTo(2 / 3);
    expect(k.relevantRate.red).toBe(true); // below 85%
    expect(k.beyondNina).toMatchObject({ value: 0.5, red: true }); // below 60%
    expect(k.alertsPerUserPerDay.value).toBeCloseTo(3 / 3 / 7);
    expect(k.falseAlertRate.value).toBeCloseTo(1 / 3);
    expect(k.falseAlertRate.red).toBe(true); // above 2%
    expect(k.eventToPushP50.value).toBe(180);
    expect(k.eventToPushP90.value).toBe(1800);
  });

  it('no data → no values, nothing red', () => {
    const k = computeKpis({ alerts: [], users: [] }, { sinceIso: ago(24 * 7), now: NOW, falseAlertEvents: new Set() });
    expect(k.every((x) => x.value === null || x.key === 'alertsPerUserPerDay')).toBe(true);
    expect(k.some((x) => x.red)).toBe(false);
  });
});

describe.each(storeBackends())('KPI data ($name)', (backend) => {
  let store: Store, clock: Date;
  beforeEach(async () => { store = await backend.make(); clock = new Date(NOW); });
  afterEach(async () => { await store.close(); });

  it('last seen is written at most once an hour; an alert is "opened" once', async () => {
    const { user } = await store.createUser('ExponentPushToken[a]');
    await store.markSeen(user.id, '2026-11-23T10:00:00.000Z');
    await store.markSeen(user.id, '2026-11-23T10:30:00.000Z');
    const seen = (await store.kpiInputs(ago(1000))).users[0].lastSeenAt;
    expect(seen).toBe('2026-11-23T10:00:00.000Z');
    await store.markSeen(user.id, '2026-11-23T11:30:00.000Z');
    expect((await store.kpiInputs(ago(1000))).users[0].lastSeenAt).toBe('2026-11-23T11:30:00.000Z');
  });

  it('end to end: opening a pushed alert, retracting it as false, the KPI endpoint', async () => {
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(),
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 }, now: () => clock });
    const app = buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock });
    const reg = (await app.inject({ method: 'POST', url: '/v1/devices', payload: { pushToken: 'ExponentPushToken[k]', prefs: { timezone: 'Europe/Berlin' } } })).json();
    const auth = { authorization: `Bearer ${reg.token}` };
    await app.inject({ method: 'POST', url: '/v1/me/location', headers: auth, payload: { lat: 52.5155, lon: 13.4549 } });

    const warning: SourceItem = {
      source: 'nina', sourceName: 'NINA (BBK)', externalId: 'w1', official: true, title: 'Gefahreninformation Friedrichshain', body: 'Fenster und Türen schließen.',
      publishedAt: new Date(clock.getTime() - 120_000).toISOString(), lat: 52.5155, lon: 13.4549, radiusM: 2000, officialSeverity: 4, category: 'public_safety', areaName: 'Friedrichshain',
    };
    await pipeline.ingest([warning]);
    const [a] = (await app.inject({ method: 'GET', url: '/v1/me/alerts', headers: auth })).json().alerts;
    expect(a.delivery).toBe('push');
    await app.inject({ method: 'GET', url: `/v1/alerts/${a.id}`, headers: auth });
    await app.inject({ method: 'GET', url: `/v1/alerts/${a.id}`, headers: auth });

    const h = { 'x-admin-token': 'secret' };
    let k = byKey((await app.inject({ method: 'GET', url: '/admin/api/kpis', headers: h })).json().kpis);
    expect(k.openRate).toMatchObject({ value: 1, basedOn: 1 });
    expect(k.pushOptIn.value).toBe(1);
    expect(k.eventToPushP50.value).toBe(120);
    expect(k.falseAlertRate.value).toBe(0);

    expect((await app.inject({ method: 'POST', url: `/admin/api/events/${a.eventId}/end`, headers: h, payload: { reason: 'false_alert' } })).statusCode).toBe(200);
    k = byKey((await app.inject({ method: 'GET', url: '/admin/api/kpis', headers: h })).json().kpis);
    expect(k.falseAlertRate).toMatchObject({ value: 1, red: true });
    expect((await store.decisions({ kind: 'desk' }))[0].detail.reason).toBe('false_alert');

    // Without a body, "End now" means "it's over".
    expect((await app.inject({ method: 'POST', url: `/admin/api/events/${a.eventId}/end`, headers: h })).statusCode).toBe(200);
    expect((await store.decisions({ kind: 'desk' }))[0].detail.reason).toBe('over');
    expect((await app.inject({ method: 'POST', url: `/admin/api/events/${a.eventId}/end`, headers: h, payload: { reason: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/admin/api/kpis' })).statusCode).toBe(401);
  });
});
