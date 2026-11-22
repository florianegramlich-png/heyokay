import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DWD_HEALTH_URL, POLLEN_UV_KEYS, berlinDate, dayKey, fetchPollenUv, pollenItems, pollenUvDue, uvItems } from '../src/sources/dwd-health.js';
import { POLLEN_REGIONS, UV_CITIES } from '../src/data/dwd-health-areas.js';
import { distanceToAreasM } from '../src/geo.js';
import { describeSource } from '../src/sources/registry.js';
import { decide } from '../src/pipeline/rank.js';
import { recommendedAction } from '../src/pipeline/guidance.js';
import { CATEGORIES, DEFAULT_PREFS, normalizePrefs } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { buildApi } from '../src/api.js';
import { SqliteStore } from '../src/db.js';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

const json = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8'));
const text = (n: string) => readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8');
// Real files from 22 November 2026; the spring and summer files are the same files with the
// values of a few areas and places raised (in November there is no pollen and hardly any UV).
const POLLEN_NOV = json('dwd-pollen-november.json');
const UV_NOV = json('dwd-uvi-november.json');
const POLLEN_SPRING = json('dwd-pollen-spring.json'); // issued 2026-04-14 11:00
const UV_SUMMER = json('dwd-uvi-summer.json'); // forecast_day 2026-06-21
const SPRING_MORNING = new Date('2026-04-15T05:30:00Z'); // 07:30 in Berlin
const SUMMER_MORNING = new Date('2026-06-22T05:30:00Z');
const BERLIN = { lat: 52.52, lon: 13.405 };
const FRANKFURT = { lat: 50.11, lon: 8.68 };
const MUENCHEN = { lat: 48.137, lon: 11.575 };
const HAMBURG = { lat: 53.55, lon: 9.99 };
const inside = (areas: [number, number][][], p: { lat: number; lon: number }) => distanceToAreasM(p.lat, p.lon, areas) === 0;

describe('DWD pollen and UV forecasts', () => {
  it('reads the day that is today: a file from yesterday calls today "tomorrow"', () => {
    expect(berlinDate(new Date('2026-04-14T22:30:00Z'))).toBe('2026-04-15'); // 00:30 in Berlin
    expect(dayKey('2026-04-15', '2026-04-15')).toBe('today');
    expect(dayKey('2026-04-14', '2026-04-15')).toBe('tomorrow');
    expect(dayKey('2026-04-13', '2026-04-15')).toBe('dayafter_to');
    expect(dayKey('2026-04-12', '2026-04-15')).toBeNull(); // too old: nothing rather than a stale forecast
    expect(dayKey('2026-04-16', '2026-04-15')).toBeNull();
  });

  it('pollen: one alert per area and type from "mittel" up, "2-3" and "3" count as high', () => {
    const items = pollenItems(POLLEN_SPRING, '2026-04-15');
    expect(items.map((i) => [i.externalId, i.officialSeverity])).toEqual([
      ['dwd-health:pollen:2026-04-15:50:birke', 2],
      ['dwd-health:pollen:2026-04-15:92:birke', 2],
      ['dwd-health:pollen:2026-04-15:92:graeser', 1],
    ]); // Esche "1-2" in Berlin and Hasel "1" in Bavaria stay out
    expect(items[0]).toMatchObject({
      source: 'dwd-health', sourceName: 'Deutscher Wetterdienst · Pollenflug', official: true, structured: true,
      category: 'pollen_uv', hazard: 'pollen', pollenUv: 'birke', language: 'de', country: 'DE',
      title: 'Pollenflug heute: Birke mittel bis hoch', areaName: 'Brandenburg und Berlin',
      body: 'Birkenpollen heute mittel bis hoch (Stufe 2-3 von 3) in Brandenburg und Berlin. Quelle: Deutscher Wetterdienst.',
      publishedAt: '2026-04-15T06:00:00.000Z', expiresAt: '2026-04-15T22:00:00.000Z',
    });
    expect(inside(items[0].areas!, BERLIN)).toBe(true);
    expect(inside(items[0].areas!, FRANKFURT)).toBe(false);
    expect(inside(items[1].areas!, FRANKFURT)).toBe(true);
    expect(items[2].title).toBe('Pollenflug heute: Gräser mittel');
    // The same file read a day later shows the day after; in November there's nothing.
    expect(pollenItems(POLLEN_SPRING, '2026-04-16').map((i) => i.externalId)).toEqual(['dwd-health:pollen:2026-04-16:50:birke']);
    expect(pollenItems(POLLEN_NOV, '2026-11-22')).toEqual([]);
  });

  it('UV: from 6 in the feed, 8 and up high; mountain stations left out', () => {
    const items = uvItems(UV_SUMMER, '2026-06-22');
    expect(items.map((i) => [i.externalId, i.officialSeverity, i.title])).toEqual([
      ['dwd-health:uv:2026-06-22:Berlin', 2, 'UV-Index heute: 8 (sehr hoch)'],
      ['dwd-health:uv:2026-06-22:München', 1, 'UV-Index heute: 7 (hoch)'],
      ['dwd-health:uv:2026-06-22:Hamburg', 1, 'UV-Index heute: 6 (hoch)'],
    ]); // Zugspitze (11) is not where people live
    expect(items[0]).toMatchObject({ hazard: 'uv', pollenUv: 'uv', category: 'pollen_uv', areaName: 'Raum Berlin', body: 'UV-Index heute bis 8 im Raum Berlin. Quelle: Deutscher Wetterdienst.' });
    expect(inside(items[0].areas!, BERLIN)).toBe(true);
    expect(inside(items[1].areas!, MUENCHEN)).toBe(true);
    expect(inside(items[1].areas!, BERLIN)).toBe(false);
    expect(uvItems(UV_NOV, '2026-11-22')).toEqual([]);
  });

  it('areas: 27 pollen areas cover Germany; every UV place sits in its own area, and each town in exactly one', () => {
    expect(Object.keys(POLLEN_REGIONS)).toHaveLength(27);
    for (const c of POLLEN_NOV.content) expect(POLLEN_REGIONS[c.partregion_id > 0 ? c.partregion_id : c.region_id], c.partregion_name).toBeTruthy();
    const towns = [BERLIN, FRANKFURT, MUENCHEN, HAMBURG, { lat: 50.94, lon: 6.96 }, { lat: 47.99, lon: 7.85 }, { lat: 54.32, lon: 10.12 }, { lat: 51.05, lon: 13.74 }, { lat: 54.9, lon: 8.31 } /* Sylt */];
    for (const p of towns) {
      expect(Object.values(POLLEN_REGIONS).filter((r) => inside(r.rings, p)).length, `${p.lat},${p.lon}`).toBeGreaterThanOrEqual(1);
      expect(Object.values(UV_CITIES).filter((c) => inside(c.rings, p)), `${p.lat},${p.lon}`).toHaveLength(1);
    }
    for (const [name, c] of Object.entries(UV_CITIES)) expect(inside(c.rings, c), name).toBe(true);
    expect(UV_CITIES.Zugspitze).toBeUndefined();
    const paris = { lat: 48.86, lon: 2.35 };
    expect(Object.values(UV_CITIES).some((c) => inside(c.rings, paris))).toBe(false);
  });

  it('reads both files; a changed file fails instead of looking like "no pollen"; once a day after 07:05', async () => {
    const urls: string[] = [];
    const get = async (u: string) => { urls.push(u); return u.endsWith('s31fg.json') ? JSON.stringify(POLLEN_SPRING) : JSON.stringify(UV_SUMMER); };
    const items = await fetchPollenUv((id) => id !== 'dwd-health:pollen:2026-04-15:92:graeser', get, { now: SPRING_MORNING });
    expect(urls).toEqual([`${DWD_HEALTH_URL}/s31fg.json`, `${DWD_HEALTH_URL}/uvi.json`]);
    expect(items.map((i) => i.externalId)).toEqual(['dwd-health:pollen:2026-04-15:50:birke', 'dwd-health:pollen:2026-04-15:92:birke']); // the UV file is from June: not today
    await expect(fetchPollenUv(() => true, async () => '<html>Wartung</html>', { now: SPRING_MORNING })).rejects.toThrow(/not JSON/);
    await expect(fetchPollenUv(() => true, async () => '{"content":"x"}', { now: SPRING_MORNING })).rejects.toThrow(/unexpected format/);
    expect(pollenUvDue(new Date('2026-04-15T05:00:00Z'), null)).toBe(false); // 07:00 in Berlin
    expect(pollenUvDue(new Date('2026-04-15T05:06:00Z'), null)).toBe(true);
    expect(pollenUvDue(new Date('2026-04-15T15:00:00Z'), '2026-04-15')).toBe(false);
    expect(pollenUvDue(new Date('2026-04-16T05:06:00Z'), '2026-04-15')).toBe(true);
    expect(text('dwd-pollen-november.json')).toContain('Deutscher Wetterdienst');
  });

  it('opt-in, only the picked types, "hoch" pushes once and only in the morning', () => {
    expect(CATEGORIES).toContain('pollen_uv');
    expect(DEFAULT_PREFS.categories).not.toContain('pollen_uv');
    expect(normalizePrefs({ categories: ['weather'], knownCategories: ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure', 'technology', 'recall'] }).categories).toEqual(['weather']);
    expect(normalizePrefs({}).categories).not.toContain('pollen_uv');
    const base = { id: 'u', tokenHash: '', pushToken: 'x', lat: null, lon: null, locationUpdatedAt: null, createdAt: '' };
    const user = (pollenUv?: string[] | null, on = true) => ({ ...base, prefs: { ...normalizePrefs({ categories: on ? ['weather', 'pollen_uv'] : ['weather'] }), pollenUv } });
    const birch = { category: 'pollen_uv', severity: 2, official: true, hazard: 'pollen', pollenUv: 'birke' } as any;
    const ctx = (now: Date, pushed = false) => ({ now, pushesLast24h: 0, feedback: {}, pollenUvPushedRecently: pushed });
    const morning = new Date('2026-04-15T05:30:00Z'); // 07:30
    expect(decide(user(null, false), birch, ctx(morning))).toEqual({ delivery: 'suppressed', reason: 'category turned off' });
    expect(decide(user(null), birch, ctx(morning))).toEqual({ delivery: 'push', reason: 'relevant' });
    expect(decide(user(['birke', 'uv']), birch, ctx(morning)).delivery).toBe('push');
    expect(decide(user(['graeser']), birch, ctx(morning))).toEqual({ delivery: 'suppressed', reason: 'pollen type not followed' });
    expect(decide(user(null), birch, ctx(morning, true))).toEqual({ delivery: 'feed', reason: 'pollen/UV: one push a day' });
    expect(decide(user(null), birch, ctx(new Date('2026-04-15T10:00:00Z')))).toEqual({ delivery: 'feed', reason: 'pollen/UV: push only in the morning' }); // 12:00
    expect(decide(user(null), birch, ctx(new Date('2026-04-14T20:00:00Z'))).delivery).toBe('feed'); // 22:00
    expect(decide(user(null), { ...birch, severity: 1 }, ctx(morning))).toEqual({ delivery: 'feed', reason: 'pollen/UV: moderate, feed only' });
    expect(recommendedAction('pollen_uv', 2, 'de', 'pollen')).toMatch(/^Bei Allergie: Aufenthalt im Freien kurz halten/);
    expect(recommendedAction('pollen_uv', 1, 'en', 'uv')).toMatch(/^Seek shade/);
    expect(recommendedAction('pollen_uv', 2, 'en', 'uv')).toMatch(/^Stay in the shade between 11 am and 4 pm/);
    expect(describeSource('dwd-health:DE')).toMatchObject({ country: 'DE', official: true });
    expect(loadConfig({}).dwdHealth).toBe(DWD_HEALTH_URL);
    expect(loadConfig({ DWD_HEALTH_URL: 'off' }).dwdHealth).toBeNull();
    expect(POLLEN_UV_KEYS).toEqual(['hasel', 'erle', 'esche', 'birke', 'graeser', 'roggen', 'beifuss', 'ambrosia', 'uv']);
  });

  it('API: prefs accept the pollen/UV picks or null and reject unknown types', async () => {
    const store = new SqliteStore();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const app = buildApi({ store, pipeline, adminToken: 'x', runIngest: async () => ({}) });
    const reg = (await app.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json();
    expect(reg.prefs.pollenUv).toBeUndefined();
    const auth = { authorization: `Bearer ${reg.token}` };
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: auth, payload });
    expect((await put({ categories: ['weather', 'pollen_uv'], pollenUv: ['birke', 'uv'] })).json().prefs).toMatchObject({ categories: ['weather', 'pollen_uv'], pollenUv: ['birke', 'uv'] });
    expect((await put({ pollenUv: null })).json().prefs.pollenUv).toBeNull();
    expect((await put({ pollenUv: ['tulpe'] })).statusCode).toBe(400);
    await app.close(); await store.close();
  });
});

describe.each(storeBackends())('pollen and UV end to end ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('birch "hoch" in Berlin: one morning push for people who opted in, feed for the second alert, nothing for the rest', async () => {
    const push = new MemoryPushSender();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: loadConfig({}), now: () => SPRING_MORNING });
    const at = async (p: { lat: number; lon: number }, token: string, prefs: object) => {
      const { user } = await store.createUser(token, { language: 'de', ...prefs } as any);
      await store.updateLocation(user.id, p.lat, p.lon);
      return user;
    };
    const optedIn = await at(BERLIN, 'ExponentPushToken[on]', { categories: ['weather', 'pollen_uv'] });
    const grassOnly = await at(BERLIN, 'ExponentPushToken[grass]', { categories: ['weather', 'pollen_uv'], pollenUv: ['graeser'] });
    const off = await at(BERLIN, 'ExponentPushToken[off]', {});
    const frankfurt = await at(FRANKFURT, 'ExponentPushToken[ffm]', { categories: ['weather', 'pollen_uv'] });

    const items = await fetchPollenUv(() => true, async (u) => JSON.stringify(u.endsWith('s31fg.json') ? POLLEN_SPRING : UV_SUMMER), { now: SPRING_MORNING });
    expect(await pipeline.ingest(items)).toMatchObject({ eventsCreated: 3, sentToReview: 0 });
    const [mine] = await store.alertsForUser(optedIn.id);
    expect(mine).toMatchObject({ category: 'pollen_uv', delivery: 'push', title: 'Pollenflug heute: Birke mittel bis hoch' });
    expect(mine.action).toMatch(/^Bei Allergie/);
    expect(await store.alertsForUser(grassOnly.id)).toEqual([]);
    expect(await store.alertsForUser(off.id)).toEqual([]);
    // Frankfurt: birch "3" pushes, grasses "2" go to the feed. One push only.
    const ffm = await store.alertsForUser(frankfurt.id);
    expect(ffm.map((a) => [a.title, a.delivery]).sort()).toEqual([['Pollenflug heute: Birke hoch', 'push'], ['Pollenflug heute: Gräser mittel', 'feed']]);
    expect(push.outbox.map((m) => m.token).sort()).toEqual(['ExponentPushToken[ffm]', 'ExponentPushToken[on]']);

    // A second high alert the same morning (UV) goes to the feed: one pollen/UV push a day.
    const uv = uvItems({ ...UV_SUMMER, forecast_day: '2026-04-15' }, '2026-04-15').filter((i) => i.externalId.endsWith(':Berlin'));
    uv[0].officialSeverity = 2;
    await pipeline.ingest(uv);
    expect((await store.alertsForUser(optedIn.id)).map((a) => [a.title, a.delivery])).toContainEqual(['UV-Index heute: 7 (hoch)', 'feed']);
    expect(push.outbox).toHaveLength(2);
  });
});
