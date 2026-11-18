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

  it('fall back to the circle for warnings with very many outlines', () => {
    const ring = [[13, 52], [13.01, 52], [13.01, 52.01], [13, 52]];
    const many = { features: Array.from({ length: 61 }, () => ({ geometry: { type: 'Polygon', coordinates: [ring] } })) };
    expect(warningAreas(many)).toBeUndefined();
    expect(warningAreas({ features: [{ geometry: { type: 'Polygon', coordinates: [ring] } }] })).toHaveLength(1);
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
