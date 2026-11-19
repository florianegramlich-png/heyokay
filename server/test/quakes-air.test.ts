import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { countryNear, fetchQuakes, quakeImpact, quakeItem, type UsgsFeature } from '../src/sources/usgs.js';
import { airItem, fetchAir, type AirForecast } from '../src/sources/air.js';
import { SqliteStore } from '../src/db.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { describeSource } from '../src/sources/registry.js';

const USGS = JSON.parse(readFileSync(new URL('./fixtures/usgs-2.5_hour.geojson', import.meta.url), 'utf8')) as { features: UsgsFeature[] };
const AIR = JSON.parse(readFileSync(new URL('./fixtures/owm-air-forecast-poor.json', import.meta.url), 'utf8')) as AirForecast;
const NOW = new Date(1763510400000); // 2025-11-19T00:00:00Z (fixture epoch)
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };

describe('earthquakes (USGS)', () => {
  it('impact from magnitude, raised by USGS PAGER; small quakes ignored', () => {
    expect(quakeImpact(3.9)).toBeNull();
    expect(quakeImpact(4.2)).toEqual({ severity: 1, radiusM: 40_000 });
    expect(quakeImpact(5.3)).toEqual({ severity: 2, radiusM: 100_000 });
    expect(quakeImpact(6.4)).toEqual({ severity: 3, radiusM: 250_000 });
    expect(quakeImpact(6.4, 'orange')!.severity).toBe(4);
    expect(quakeImpact(5.0, 'red')!.severity).toBe(5);
  });

  it('only launch countries; offshore near the coast counts', () => {
    expect(countryNear(36.93, -121.32)).toBe('US');
    expect(countryNear(52.5, 13.4)).toBe('DE');
    expect(countryNear(13.0, 77.6)).toBe('IN');
    expect(countryNear(-17.9, -178.4)).toBeNull();
    expect(countryNear(36.6, -122.3)).toBe('US'); // Monterey Bay, just offshore
  });

  it('maps the feed: Hollister M5.3 in; small, far-away and non-earthquake events out', async () => {
    const items = await fetchQuakes(() => true, async () => USGS, { now: NOW });
    expect(items.map((i) => i.externalId)).toEqual(['usgs:nc75012345']);
    expect(items[0]).toMatchObject({
      hazard: 'earthquake', category: 'public_safety', official: true, country: 'US', language: 'en',
      title: 'Magnitude 5.3 earthquake', officialSeverity: 2, radiusM: 100_000,
    });
    expect(items[0].body).toBe('A magnitude 5.3 earthquake 12 km NE of Hollister, CA, 8 km deep.');
    expect(describeSource('usgs:quakes').official).toBe(true);
  });

  it('German text for a quake in Germany, with a tsunami note when USGS sets the flag', () => {
    const f: UsgsFeature = { id: 'x', properties: { mag: 4.6, place: 'Schwäbische Alb', time: NOW.getTime(), tsunami: 1 }, geometry: { type: 'Point', coordinates: [9.0, 48.3, 10] } };
    const item = quakeItem(f, NOW)!;
    expect(item).toMatchObject({ language: 'de', country: 'DE', title: 'Erdbeben der Stärke 4.6' });
    expect(item.body).toContain('Tsunami-Hinweis');
  });

  it('people within the felt radius get it, with aftershock advice; people far away do not', async () => {
    const store = new SqliteStore();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => NOW });
    const near = (await store.createUser('ExponentPushToken[a]', { language: 'en', quietHours: null })).user;
    await store.updateLocation(near.id, 36.684, -121.801); // Marina, ~45 km
    const far = (await store.createUser('ExponentPushToken[b]', { language: 'en' })).user;
    await store.updateLocation(far.id, 34.05, -118.24); // Los Angeles
    await pipeline.ingest(await fetchQuakes(() => true, async () => USGS, { now: NOW }));
    const [a] = await store.alertsForUser(near.id);
    expect(a).toMatchObject({ title: 'Magnitude 5.3 earthquake', delivery: 'push' });
    expect(a.action).toBe('Expect aftershocks. Check for damage.');
    expect(await store.alertsForUser(far.id)).toHaveLength(0);
    await store.close();
  });
});

describe('air quality (OpenWeatherMap)', () => {
  it('poor → feed, very poor → severity 2 with stay-indoors advice; starts later → coming up; India gets IN', () => {
    const item = airItem({ lat: 13.0, lon: 77.6 }, AIR, NOW)!;
    expect(item).toMatchObject({ category: 'health', hazard: 'air', officialSeverity: 2, country: 'IN', language: 'en', title: 'Air quality: very poor' });
    expect(item.body).toBe('Forecast: air quality very poor, fine particles (PM2.5) up to 99 µg/m³.');
    expect(item.onsetAt).toBe('2025-11-19T01:00:00.000Z');
    expect(item.references).toEqual(['owm:air:13.00,77.60:2025-11-19:1']);
    expect(airItem({ lat: 13.0, lon: 77.6 }, { list: AIR.list.slice(0, 1) }, NOW)).toBeNull(); // moderate only
    const de = airItem({ lat: 52.5, lon: 13.4 }, AIR, NOW)!;
    expect(de).toMatchObject({ language: 'de', country: 'DE', title: 'Luftqualität: sehr schlecht' });
  });

  it('asks about grid cells only, each at most every 3 hours', async () => {
    const urls: string[] = [];
    const last = new Map<string, number>();
    const get = async (u: string) => { urls.push(u); return AIR; };
    await fetchAir([{ lat: 13.0, lon: 77.6 }], () => true, get, { now: NOW, lastChecked: last });
    await fetchAir([{ lat: 13.0, lon: 77.6 }], () => true, get, { now: new Date(NOW.getTime() + 3600_000), lastChecked: last });
    expect(urls).toEqual(['https://api.openweathermap.org/data/2.5/air_pollution/forecast?lat=13&lon=77.6']);
  });
});
