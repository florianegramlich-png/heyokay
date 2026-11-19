import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchWildfires, fireName, fireRadiusM, fireState, wfigsQueryUrl, type WfigsFeature } from '../src/sources/wildfire.js';
import { describeSource } from '../src/sources/registry.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';

// Real WFIGS records (live format, 2026-11-19). TIMBER (Monterey County, CA) edited into a fresh
// 1,250-acre fire near Big Sur for the California cases; the others are as published.
const FIRES = JSON.parse(readFileSync(new URL('./fixtures/wfigs-incidents.json', import.meta.url), 'utf8')) as { features: WfigsFeature[] };
const NOW = new Date('2026-11-19T23:00:00Z');
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
const fire = (name: string, patch: Partial<WfigsFeature['attributes']> = {}): WfigsFeature => {
  const f = structuredClone(FIRES.features.find((x) => x.attributes.IncidentName === name)!);
  Object.assign(f.attributes, patch);
  return f;
};

describe('wildfires (NIFC WFIGS)', () => {
  it('level from size, calmer when half contained or burning for weeks; done when out or contained', () => {
    expect(fireState(fire('TIMBER'), NOW)).toEqual({ kind: 'alert', level: 3 });
    expect(fireState(fire('TIMBER', { IncidentSize: 250 }), NOW)).toEqual({ kind: 'alert', level: 2 });
    expect(fireState(fire('TIMBER', { PercentContained: 55 }), NOW)).toEqual({ kind: 'alert', level: 1 });
    expect(fireState(fire('GARDA FALLS'), NOW)).toEqual({ kind: 'alert', level: 1 }); // 308 acres, 0%, but since August
    expect(fireState(fire('Walker MT West'), NOW)).toEqual({ kind: 'winding_down' }); // 90%
    expect(fireState(fire('Red Hill'), NOW)).toEqual({ kind: 'over' }); // 100%
    expect(fireState(fire('Car'), NOW)).toEqual({ kind: 'over' }); // 0.1 acres
    expect(fireState(fire('TIMBER', { FireOutDateTime: NOW.getTime() }), NOW)).toEqual({ kind: 'over' });
    expect(fireState(fire('TIMBER', { IncidentTypeCategory: 'RX' }), NOW)).toEqual({ kind: 'over' }); // prescribed burn
    expect(fireState(fire('TIMBER'), new Date(NOW.getTime() + 8 * 86_400_000))).toEqual({ kind: 'over' }); // no update for a week
    expect(fireRadiusM(250)).toBe(10_000);
    expect(fireRadiusM(1250)).toBe(20_000);
    expect(fireRadiusM(102_007)).toBe(40_000);
  });

  it('names and the query', () => {
    expect(fireName('WEST FORK')).toBe('West Fork');
    expect(fireName('43W')).toBe('43W');
    expect(fireName('BEE HAVEN (2) (24-06)')).toBe('Bee Haven (2) (24-06)');
    expect(fireName('Wild River')).toBe('Wild River');
    const url = new URL(wfigsQueryUrl());
    expect(url.searchParams.get('where')).toBe("IncidentTypeCategory='WF' AND FireOutDateTime IS NULL AND IncidentSize >= 10");
    expect(url.searchParams.get('f')).toBe('json');
  });

  it('maps the feed: US fires only, plain text, no empty template descriptions', async () => {
    const r = await fetchWildfires(() => true, async () => FIRES, { now: NOW });
    expect(r.feedKey).toBe('wfigs:US');
    expect(r.items.map((i) => [i.title, i.officialSeverity])).toEqual([
      ['Wildfire: West Fork', 1], ['Wildfire: Garda Falls', 1], ['Wildfire: Bee Haven (2) (24-06)', 1],
      ['Wildfire: Wild River', 1], ['Wildfire: Honey Bee', 1], ['Wildfire: Timber', 3],
    ]); // Puerto Rico (outside the US outline), 90%+, out and tiny fires left out
    expect(r.items[0].body).toBe('310 acres, 16% contained. Pierce County, WA.'); // "null Miles null from null" replaced
    const timber = r.items.at(-1)!;
    expect(timber).toMatchObject({
      source: 'wfigs', hazard: 'wildfire', category: 'public_safety', official: true, country: 'US', language: 'en',
      radiusM: 20_000, body: '1,250 acres, 10% contained. 6 Miles SE from Big Sur, CA.',
    });
    // Winding down (90%+): kept running, no all-clear yet.
    expect([...r.listedIds].some((x) => x.startsWith('wfigs:') && x.includes(fire('Walker MT West').attributes.IrwinID.replace(/[{}]/g, '').toLowerCase()))).toBe(true);
    expect(describeSource('wfigs:US')).toMatchObject({ country: 'US', official: true, category: 'fire' });
  });

  it('a cut-off or failed answer never reads as "all fires out"', async () => {
    await expect(fetchWildfires(() => true, async () => ({ ...FIRES, exceededTransferLimit: true }), { now: NOW })).rejects.toThrow(/page/);
    await expect(fetchWildfires(() => true, async () => ({ error: { message: 'Invalid query' } }), { now: NOW })).rejects.toThrow(/Invalid query/);
  });
});

describe.each(storeBackends())('wildfires through the pipeline ($name)', (backend) => {
  let store: Store, push: MemoryPushSender, pipeline: Pipeline, clock: Date;
  const user = async (lat: number, lon: number) => {
    const { user } = await store.createUser('ExponentPushToken[f]', { language: 'en', timezone: 'America/Los_Angeles', quietHours: null });
    await store.updateLocation(user.id, lat, lon);
    return user;
  };
  const poll = async (features: WfigsFeature[]) => {
    const r = await fetchWildfires(async (id) => !(await store.hasSourceItem('wfigs', id)), async () => ({ features }), { now: clock });
    const ing = await pipeline.ingest(r.items);
    return { ...ing, lifted: (await pipeline.reconcileFeed(r.feedKey, r.listedIds)).ended };
  };

  beforeEach(async () => {
    clock = NOW;
    store = await backend.make();
    push = new MemoryPushSender();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: cfg, now: () => clock });
  });
  afterEach(async () => { await store.close(); });

  it('people nearby get a push with evacuation-ready advice; it calms down with containment, then all-clear', async () => {
    const bigSur = await user(36.27, -121.81); // ~10 km
    const monterey = await user(36.60, -121.89); // ~45 km

    await poll(FIRES.features);
    const [a] = await store.alertsForUser(bigSur.id);
    expect(a).toMatchObject({ title: 'Wildfire: Timber', delivery: 'push' });
    expect(a.action).toBe('Be ready to leave: keep essentials at hand and follow evacuation orders from local officials. Emergency: 911.');
    expect(await store.alertsForUser(monterey.id)).toHaveLength(0);

    // Half contained: same event, calmer → one update.
    clock = new Date(NOW.getTime() + 3600_000);
    const r = await poll([fire('TIMBER', { PercentContained: 55, ModifiedOnDateTime_dt: clock.getTime() }), ...FIRES.features.filter((f) => f.attributes.IncidentName !== 'TIMBER')]);
    expect(r.eventsCreated).toBe(0);
    expect((await store.alertsForUser(bigSur.id)).map((x) => x.kind)).toEqual(['update', 'new']);

    // 92%: winding down, nothing new. Then out of the list (out or 100%): all-clear.
    await poll([fire('TIMBER', { PercentContained: 92 }), ...FIRES.features.filter((f) => f.attributes.IncidentName !== 'TIMBER')]);
    expect(await store.alertsForUser(bigSur.id)).toHaveLength(2);
    const done = await poll(FIRES.features.filter((f) => f.attributes.IncidentName !== 'TIMBER'));
    expect(done.lifted).toBe(1);
    expect((await store.alertsForUser(bigSur.id))[0].kind).toBe('all_clear');
  });
});
