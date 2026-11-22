import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EPA_UV_URL, californiaUvDue, epaDate, fetchCaliforniaUv, localDate, uvItem } from '../src/sources/us-uv.js';
import { CA_UV_PLACES } from '../src/data/ca-uv-places.js';
import { distanceToAreasM } from '../src/geo.js';
import { describeSource } from '../src/sources/registry.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

// Real EPA answers from 22 Nov 2026 (UV 2 and 3); "summer" is the same answer with the value raised.
const SF_NOV = readFileSync(join(import.meta.dirname, 'fixtures', 'epa-uv-94103.json'), 'utf8');
const LA_NOV = readFileSync(join(import.meta.dirname, 'fixtures', 'epa-uv-90012.json'), 'utf8');
const summer = (json: string, uv: number) => json.replace(/"UV_INDEX":"\d+"/, `"UV_INDEX":"${uv}"`).replace('Nov/22/2026', 'Jul/15/2026');
const SUMMER_MORNING = new Date('2026-07-15T14:30:00Z'); // 07:30 in Los Angeles
const SF = { lat: 37.77, lon: -122.42 };
const LA = { lat: 34.05, lon: -118.24 };
const inside = (areas: [number, number][][], p: { lat: number; lon: number }) => distanceToAreasM(p.lat, p.lon, areas) === 0;

describe('EPA UV index (California)', () => {
  it('dates and places', () => {
    expect(epaDate('Nov/22/2026')).toBe('2026-11-22');
    expect(epaDate('2026-11-22')).toBeNull();
    expect(localDate(new Date('2026-11-23T05:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-22');
    expect(Object.keys(CA_UV_PLACES)).toHaveLength(18);
    for (const [name, p] of Object.entries(CA_UV_PLACES)) expect(inside(p.rings, p), name).toBe(true);
    for (const p of [SF, LA, { lat: 32.72, lon: -117.16 }, { lat: 38.58, lon: -121.49 }, { lat: 36.74, lon: -119.79 }]) {
      expect(Object.values(CA_UV_PLACES).filter((c) => inside(c.rings, p))).toHaveLength(1);
    }
    expect(Object.values(CA_UV_PLACES).some((c) => inside(c.rings, { lat: 36.17, lon: -115.14 }))).toBe(false); // Las Vegas
  });

  it('UV 6–7 in the feed, 8 and up high, under 6 nothing; in English, same topic as Germany', () => {
    expect(uvItem('San Francisco', JSON.parse(SF_NOV), '2026-11-22')).toBeNull(); // UV 2
    const la = uvItem('Los Angeles', JSON.parse(summer(LA_NOV, 9)), '2026-07-15')!;
    expect(la).toMatchObject({
      source: 'epa-uv', sourceName: 'US EPA · UV Index', externalId: 'epa-uv:2026-07-15:90012', official: true, structured: true,
      category: 'pollen_uv', hazard: 'uv', pollenUv: 'uv', language: 'en', country: 'US', officialSeverity: 2,
      title: 'UV index today: 9 (very high)', body: 'UV index up to 9 today around Los Angeles. Source: US EPA.', areaName: 'Los Angeles area',
      expiresAt: '2026-07-16T08:00:00.000Z',
    });
    expect(inside(la.areas!, LA)).toBe(true);
    expect(inside(la.areas!, SF)).toBe(false);
    expect(uvItem('Los Angeles', JSON.parse(summer(LA_NOV, 7)), '2026-07-15')).toMatchObject({ officialSeverity: 1, title: 'UV index today: 7 (high)' });
    expect(uvItem('Los Angeles', JSON.parse(summer(LA_NOV, 11)), '2026-07-15')!.title).toBe('UV index today: 11 (extreme)');
    expect(uvItem('Los Angeles', JSON.parse(summer(LA_NOV, 9)), '2026-07-16')).toBeNull(); // yesterday's forecast
  });

  it('one request per place, once a day after 07:05 California time; an error answer fails', async () => {
    const urls: string[] = [];
    const get = async (u: string) => { urls.push(u); return u.includes('/90012/') ? summer(LA_NOV, 9) : summer(SF_NOV, 4); };
    const items = await fetchCaliforniaUv(() => true, get, { now: SUMMER_MORNING });
    expect(urls).toHaveLength(18);
    expect(urls[0]).toBe(`${EPA_UV_URL}/94103/JSON`);
    expect(items.map((i) => i.externalId)).toEqual(['epa-uv:2026-07-15:90012']);
    await expect(fetchCaliforniaUv(() => true, async () => '{"error": "The table is not available."}', { now: SUMMER_MORNING })).rejects.toThrow(/unexpected format/);
    await expect(fetchCaliforniaUv(() => true, async () => '<html>', { now: SUMMER_MORNING })).rejects.toThrow(/not JSON/);
    expect(californiaUvDue(new Date('2026-07-15T14:00:00Z'), null)).toBe(false); // 07:00
    expect(californiaUvDue(new Date('2026-07-15T14:06:00Z'), null)).toBe(true);
    expect(californiaUvDue(new Date('2026-07-15T20:00:00Z'), '2026-07-15')).toBe(false);
    expect(describeSource('epa-uv:US')).toMatchObject({ country: 'US', official: true });
    expect(loadConfig({}).epaUv).toBe(EPA_UV_URL);
    expect(loadConfig({ EPA_UV_URL: 'off' }).epaUv).toBeNull();
  });
});

describe.each(storeBackends())('California UV end to end ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('UV 9 in Los Angeles: a morning push for someone who opted in, in English with sun advice; nothing for San Francisco', async () => {
    const push = new MemoryPushSender();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: loadConfig({}), now: () => SUMMER_MORNING });
    const prefs = { language: 'en', timezone: 'America/Los_Angeles', categories: ['weather', 'pollen_uv'] };
    const la = (await store.createUser('ExponentPushToken[la]', prefs as any)).user;
    await store.updateLocation(la.id, LA.lat, LA.lon);
    const sf = (await store.createUser('ExponentPushToken[sf]', prefs as any)).user;
    await store.updateLocation(sf.id, SF.lat, SF.lon);
    const items = await fetchCaliforniaUv(() => true, async (u) => (u.includes('/90012/') ? summer(LA_NOV, 9) : summer(SF_NOV, 3)), { now: SUMMER_MORNING });
    await pipeline.ingest(items);
    const [alert] = await store.alertsForUser(la.id);
    expect(alert).toMatchObject({ category: 'pollen_uv', delivery: 'push', title: 'UV index today: 9 (very high)' });
    expect(alert.action).toMatch(/^Stay in the shade between 11 am and 4 pm/);
    expect(await store.alertsForUser(sf.id)).toEqual([]);
    expect(push.outbox.map((m) => m.token)).toEqual(['ExponentPushToken[la]']);
  });
});
