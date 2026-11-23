import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Store } from '../src/store.js';
import type { RiskEvent } from '../src/types.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';

const NOW = new Date('2026-11-22T12:00:00Z');

function event(over: Partial<RiskEvent> = {}): RiskEvent {
  return {
    id: randomUUID(), revision: 1, status: 'auto', category: 'transit', severity: 3, confidence: 0.9, official: false,
    title: 'S-Bahn gesperrt', summary: 'Ostkreuz gesperrt', facts: '', areaName: 'Ostkreuz',
    lat: 52.503, lon: 13.469, radiusM: 1000, startsAt: new Date(NOW.getTime() - 3600_000).toISOString(), endsAt: null,
    sources: [{ sourceName: 'S-Bahn Berlin', externalId: 'x', title: 'S-Bahn gesperrt', official: false }],
    copyTitle: null, copyBody: null, copyAction: null, copyIsTemplate: false,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

describe.each(storeBackends())('geofence regions for the phone ($name)', (backend) => {
  let store: Store, app: ReturnType<typeof buildApi>;
  beforeEach(async () => {
    store = await backend.make();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}), now: () => NOW });
    app = buildApi({ store, pipeline, adminToken: 'a', runIngest: async () => ({}), errorSink: () => {}, now: () => NOW });
  });
  afterEach(async () => { await store.close(); });

  const call = (url: string, token?: string) => app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('nearby local events in followed topics, closest first; not far ones, big areas, unreviewed, ended or unfollowed', async () => {
    const { user, token } = await store.createUser(null, { categories: ['transit', 'crime'] });
    expect((await call('/v1/me/regions', token)).json()).toEqual({ regions: [] }); // no location yet

    await store.updateLocation(user.id, 52.52, 13.405); // Berlin Mitte
    const near = event({ lat: 52.521, lon: 13.41, radiusM: 120 });
    const further = event({ lat: 52.503, lon: 13.469, radiusM: 1000 });
    await store.saveEvent(near);
    await store.saveEvent(further);
    await store.saveEvent(event({ lat: 53.55, lon: 9.99 })); // Hamburg: too far
    await store.saveEvent(event({ radiusM: 700_000, lat: 51.16, lon: 10.45 })); // nationwide recall-sized area
    await store.saveEvent(event({ status: 'pending_review' }));
    await store.saveEvent(event({ status: 'rejected' }));
    await store.saveEvent(event({ endsAt: new Date(NOW.getTime() - 60_000).toISOString() }));
    await store.saveEvent(event({ category: 'weather' })); // not followed

    const r = (await call('/v1/me/regions', token)).json();
    expect(r.regions).toEqual([
      { id: near.id, lat: 52.521, lon: 13.41, radiusM: 200 }, // at least 200 m, so the phone can notice it
      { id: further.id, lat: 52.503, lon: 13.469, radiusM: 1000 },
    ]);
    expect((await call('/v1/me/regions')).statusCode).toBe(401);
  });

  it('at most 15, so the home area and saved places still fit into iOS\'s 20', async () => {
    const { user, token } = await store.createUser(null, { categories: ['transit'] });
    await store.updateLocation(user.id, 52.52, 13.405);
    for (let i = 0; i < 20; i++) await store.saveEvent(event({ lat: 52.52 + i * 0.01, lon: 13.405 }));
    const r = (await call('/v1/me/regions', token)).json();
    expect(r.regions).toHaveLength(15);
    expect(r.regions[0].lat).toBe(52.52);
  });
});
