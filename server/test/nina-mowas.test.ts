import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSourceItem, warningAreas } from '../src/sources/nina.js';
import { distanceM } from '../src/geo.js';
import { SqliteStore } from '../src/db.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

const fx = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8'));
// A real MoWaS warning (also sent as Cell Broadcast / EU-Alert): drinking water in parts of Rettenbach, Lkr. Regensburg.
const ENTRY = { id: 'mow.DE-BY-R-SE084-20261103-84-000', version: 21, type: 'Alert' };

describe('NINA MoWaS (EU-Alert) warnings', () => {
  it('keep the exact warned area for matching, not only the enclosing circle', () => {
    const item = toSourceItem('mowas', ENTRY, fx('nina-mowas-warning.json'), fx('nina-mowas-geo.json'))!;
    expect(item).toMatchObject({ source: 'nina', sourceName: 'NINA · MoWaS', official: true, category: 'health', officialSeverity: 2 });
    expect(item.areas).toHaveLength(1);
    expect(item.areas![0][0]).toEqual([12.409, 49.0537]);
    expect(item.title).toContain('Trinkwasserverschmutzung');
  });

  it("add the authority's extra instructions to the text", () => {
    const warning = fx('nina-mowas-warning.json');
    const de = warning.info.find((i: any) => i.language === 'de');
    de.parameter = [...(de.parameter ?? []), { valueName: 'instructionText', value: 'Zusätzliche Hinweise:<br/>- Wasser 10 Minuten abkochen.' }];
    const item = toSourceItem('mowas', ENTRY, warning, fx('nina-mowas-geo.json'))!;
    expect(item.body).toContain('Trinken Sie kein Leitungswasser.');
    expect(item.body).toContain('Zusätzliche Hinweise:\n- Wasser 10 Minuten abkochen.');
  });

  it('keep outlines for warnings over many municipalities, thinned to a budget; only extreme counts fall back to the circle', () => {
    const ring = (lon: number) => Array.from({ length: 200 }, (_, i) => [lon + 0.01 * Math.cos(i / 32), 52 + 0.01 * Math.sin(i / 32)]);
    const poly = (lon: number) => ({ geometry: { type: 'Polygon', coordinates: [ring(lon)] } });
    // 120 municipalities spread from the west to the east of Germany: outlines kept, not one huge circle.
    const scattered = warningAreas({ features: Array.from({ length: 120 }, (_, i) => poly(6 + i * 0.07)) })!;
    expect(scattered).toHaveLength(120);
    expect(scattered.reduce((n, r) => n + r.length, 0)).toBeLessThanOrEqual(6000 + 120);
    expect(scattered[0].length).toBeLessThan(200);
    expect(warningAreas({ features: Array.from({ length: 501 }, () => poly(13)) })).toBeUndefined();
    const single = warningAreas({ features: [poly(13)] })![0];
    expect(single.length).toBeGreaterThan(50); // a single area keeps up to about 150 points
    expect(single.length).toBeLessThanOrEqual(151);
    expect(warningAreas(null)).toBeUndefined();
  });

  it('reach people inside the warned area, not people who are only inside its circle', async () => {
    const item = toSourceItem('mowas', ENTRY, fx('nina-mowas-warning.json'), fx('nina-mowas-geo.json'))!;
    const store = new SqliteStore(':memory:');
    const pipeline = new Pipeline({
      store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(),
      now: () => new Date('2026-11-03T18:00:00+01:00'),
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 },
    });
    const { user: inside } = await store.createUser('ExponentPushToken[in]');
    await store.updateLocation(inside.id, 49.06, 12.45);
    await store.updatePrefs(inside.id, { ...inside.prefs, categories: [...inside.prefs.categories, 'health'] });
    const { user: nearby } = await store.createUser('ExponentPushToken[out]');
    await store.updateLocation(nearby.id, 49.025, 12.45); // ~1.9 km south of the area's edge
    await store.updatePrefs(nearby.id, { ...nearby.prefs, categories: [...nearby.prefs.categories, 'health'] });
    // With only the circle (+1.5 km buffer), this person would have been matched.
    expect(distanceM(49.025, 12.45, item.lat!, item.lon!)).toBeLessThan(item.radiusM! + 1500);

    await pipeline.ingest([item]);
    expect(await store.alertsForUser(inside.id)).toHaveLength(1);
    expect(await store.alertsForUser(nearby.id)).toHaveLength(0);
    await store.close();
  });
});

describe('alert titles for warnings over several municipalities', () => {
  it('name the warning, not the first municipality, in sentence case', async () => {
    const { template, sentenceCase } = await import('../src/pipeline/compose.js');
    expect(sentenceCase('WARNUNG vor STURMBÖEN')).toBe('Warnung vor Sturmböen');
    expect(sentenceCase('Unwetterwarnung vor ORKANARTIGEN BÖEN')).toBe('Unwetterwarnung vor Orkanartigen Böen');
    const event: any = {
      category: 'weather', language: 'de', official: true,
      areaName: 'Gemeinde Bodensee, Gemeinde Bilshausen, Stadt Bad Sachsa',
      title: 'Amtliche WARNUNG vor STURMBÖEN',
      sources: [{ sourceName: 'Deutscher Wetterdienst', externalId: 'x', title: 'Amtliche WARNUNG vor STURMBÖEN', official: true }],
    };
    expect(template(event).title).toBe('Wetter: Warnung vor Sturmböen');
    expect(template(event).body).toBe('Amtliche WARNUNG vor STURMBÖEN'); // the official text stays as issued
    expect(template({ ...event, areaName: 'Berlin - Friedrichshain-Kreuzberg' }).title).toBe('Wetter: Berlin - Friedrichshain-Kreuzberg');
  });
});
