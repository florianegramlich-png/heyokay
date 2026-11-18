import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchHeat, heatItem, heatSeverity, owmFetcher, CELL_DEG, type Forecast } from '../src/sources/heat.js';
import { cellOf, type Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { loadConfig } from '../src/config.js';

const hot: Forecast = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'owm-forecast-hot.json'), 'utf8'));
const NOON = new Date('2026-07-24T12:00:00Z');
const BERLIN = cellOf(52.52, 13.405, CELL_DEG);
const scale = (f: Forecast, d: number): Forecast => ({ ...f, list: f.list.map((s) => ({ ...s, main: { temp: s.main.temp + d, feels_like: s.main.feels_like + d } })) });

describe('heat from the OpenWeatherMap forecast', () => {
  it('levels: 32 → feed only, 35 → 2, 38 → 3, never higher', () => {
    expect(heatSeverity(31.9)).toBeNull();
    expect(heatSeverity(32)).toBe(1);
    expect(heatSeverity(35.1)).toBe(2);
    expect(heatSeverity(45)).toBe(3);
    expect(heatSeverity(30, 28)).toBe(1); // threshold is configurable
  });

  it('one item per cell and day, with the hottest felt temperature of the next 24 hours', () => {
    const item = heatItem(BERLIN, hot, NOON)!;
    expect(item).toMatchObject({
      source: 'owm', official: false, structured: true, hazard: 'heat', category: 'weather', language: 'de',
      officialSeverity: 2, title: 'Hitze: bis 37 °C gefühlt', radiusM: 8000, lat: BERLIN.lat, lon: BERLIN.lon,
      externalId: `owm:heat:${BERLIN.lat.toFixed(2)},${BERLIN.lon.toFixed(2)}:2026-07-24:2`,
    });
    expect(item.references).toEqual([`owm:heat:${BERLIN.lat.toFixed(2)},${BERLIN.lon.toFixed(2)}:2026-07-24:1`]);
    expect(item.body).toContain('Lufttemperatur bis 35 °C, gefühlt bis 37 °C');
    expect(item.expiresAt).toBe('2026-07-25T00:00:00.000Z'); // last hot slot within 24 h (21:00, 32 °C felt) + 3 h
    expect(heatItem(BERLIN, scale(hot, -10), NOON)).toBeNull();
  });

  it('outside Germany: English with °F (US test mode)', () => {
    const marina = cellOf(36.684, -121.801, CELL_DEG);
    const item = heatItem(marina, scale(hot, 2), NOON)!;
    expect(item.language).toBe('en');
    expect(item.title).toBe('Heat: feels like up to 39 °C (102 °F)');
    expect(item.officialSeverity).toBe(3);
  });

  it('asks about grid cells only, each at most every 3 hours, and only reports new levels', async () => {
    const urls: string[] = [];
    const get = async (url: string) => { urls.push(url); return hot; };
    const last = new Map<string, number>();
    const seen = new Set<string>();
    const isNew = (id: string) => !seen.has(id);
    const r1 = await fetchHeat([BERLIN], isNew, get, { now: NOON, lastChecked: last });
    expect(r1).toMatchObject({ checked: 1, skipped: 0 });
    expect(urls[0]).toBe(`https://api.openweathermap.org/data/2.5/forecast?lat=${BERLIN.lat}&lon=${BERLIN.lon}&units=metric`);
    r1.items.forEach((i) => seen.add(i.externalId));
    const r2 = await fetchHeat([BERLIN], isNew, get, { now: new Date(NOON.getTime() + 3600_000), lastChecked: last });
    expect(r2).toMatchObject({ checked: 0, skipped: 1, items: [] });
    const r3 = await fetchHeat([BERLIN], isNew, get, { now: new Date(NOON.getTime() + 3 * 3600_000), lastChecked: last });
    expect(r3.checked).toBe(1);
    expect(r3.items).toEqual([]); // same day, same level: nothing new
  });

  it('sends the key as appid but never puts it in an error message', async () => {
    const real = globalThis.fetch;
    const seenUrls: string[] = [];
    globalThis.fetch = (async (url: string) => { seenUrls.push(url); return new Response('{"cod":401}', { status: 401 }); }) as typeof fetch;
    try {
      await expect(owmFetcher('s3cret')('https://api.openweathermap.org/data/2.5/forecast?lat=1&lon=2&units=metric')).rejects.toThrow('OpenWeatherMap → HTTP 401');
      await owmFetcher('s3cret')('https://x.test/?a=1').catch((e: Error) => expect(e.message).not.toContain('s3cret'));
      expect(seenUrls[0]).toContain('&appid=s3cret');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('is off without a key; threshold from config', () => {
    expect(loadConfig({}).openWeatherApiKey).toBeNull();
    expect(loadConfig({ OPENWEATHER_API_KEY: 'k', HEAT_THRESHOLD_C: '30' })).toMatchObject({ openWeatherApiKey: 'k', heatThresholdC: 30 });
  });
});

describe.each(storeBackends())('heat end to end ($name)', (backend) => {
  let store: Store, push: MemoryPushSender, pipeline: Pipeline;
  beforeEach(async () => {
    store = await backend.make();
    push = new MemoryPushSender();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, now: () => NOON, config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 } });
  });
  afterEach(async () => { await store.close(); });

  it('cells come from saved places and fresh locations, deduplicated and without exact coordinates', async () => {
    const { user } = await store.createUser(null);
    await store.addPlace(user.id, 'Mama', 52.521, 13.401, 500);
    await store.addPlace(user.id, 'Kita', 52.524, 13.409, 500); // same cell
    await store.updateLocation(user.id, 48.137, 11.575);
    const cells = await store.locationCells(CELL_DEG, '2000-01-01T00:00:00Z');
    expect(cells.map((c) => `${c.lat},${c.lon}`).sort()).toEqual([`${BERLIN.lat},${BERLIN.lon}`, '48.15,11.55'].sort());
    expect(await store.locationCells(CELL_DEG, '2999-01-01T00:00:00Z')).toHaveLength(1); // the location is old, the places stay
  });

  it("someone with a saved place gets the heat alert named after the place, with heat advice; escalation stays one event", async () => {
    const { user } = await store.createUser('ExponentPushToken[h]', { quietHours: null });
    await store.addPlace(user.id, 'Mama', 52.521, 13.401, 500);
    const r = await pipeline.ingest([heatItem(BERLIN, hot, NOON)!]);
    expect(r).toMatchObject({ eventsCreated: 1, sentToReview: 0, alertsCreated: 1 });
    const [a] = await store.alertsForUser(user.id);
    expect(a.title).toBe('Mama: Hitze: bis 37 °C gefühlt');
    expect(a.action).toContain('Viel trinken');
    expect(a.matchedPlace).toBe('Mama');

    const r2 = await pipeline.ingest([heatItem(BERLIN, scale(hot, 2), NOON)!]); // 39 °C later the same day
    expect(r2).toMatchObject({ eventsCreated: 0, eventsUpdated: 1 });
  });
});
