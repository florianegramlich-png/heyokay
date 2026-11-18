import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { capToSourceItem, fetchDwdSnapshot, parseDwdMode, DWD_FEED_KEY, DWD_LATEST_URL } from '../src/sources/dwd.js';
import { readZip } from '../src/sources/zip.js';
import { loadConfig } from '../src/config.js';
import { SqliteStore } from '../src/db.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

const fxPath = (f: string) => join(import.meta.dirname, 'fixtures', f);
const KARLSRUHE_ID = '2.49.0.0.276.0.DWD.PVW.1795022460000.36312d7c-42a8-4cae-9919-5718d7a70f09.DEU';
const HARZ_ID = '2.49.0.0.276.0.DWD.PVW.1795001880000.9413e0ba-4540-4e82-9909-a81eb21cd8fb.DEU';
const snapshot = () => readFileSync(fxPath('dwd-snapshot.zip'));

describe('DWD open data: CAP messages', () => {
  it('maps a real DWD warning (thunderstorm, Karlsruhe) to an official weather item with its exact area', () => {
    const item = capToSourceItem(readFileSync(fxPath('dwd-cap-karlsruhe.xml'), 'utf8'))!;
    expect(item).toMatchObject({
      source: 'dwd', sourceName: 'Deutscher Wetterdienst', externalId: KARLSRUHE_ID, official: true,
      category: 'weather', officialSeverity: 3, language: 'de', feedKey: DWD_FEED_KEY,
      title: 'Amtliche WARNUNG vor STARKEM GEWITTER', areaName: 'Kreis und Stadt Karlsruhe',
      expiresAt: '2026-11-18T17:45:00.000Z', references: [],
    });
    expect(item.body).toContain('Gewitter');
    // The area is around Karlsruhe, as [lon, lat] rings.
    expect(item.lat).toBeGreaterThan(48.8); expect(item.lat).toBeLessThan(49.3);
    expect(item.lon).toBeGreaterThan(8.2); expect(item.lon).toBeLessThan(8.8);
    expect(item.areas!.length).toBeGreaterThan(0);
    expect(item.areas![0][0][0]).toBeCloseTo(item.lon!, 0);
  });

  it('reads updates (with references), cancellations, and skips exercises', () => {
    const xml = readFileSync(fxPath('dwd-cap-karlsruhe.xml'), 'utf8');
    const update = xml
      .replace(`<identifier>${KARLSRUHE_ID}</identifier>`, '<identifier>upd-1</identifier>')
      .replace('<msgType>Alert</msgType>', `<msgType>Update</msgType>\n  <references>opendata@dwd.de,${KARLSRUHE_ID},2026-11-18T18:21:00+01:00</references>`)
      .replace('<severity>Moderate</severity>', '<severity>Severe</severity>');
    expect(capToSourceItem(update)).toMatchObject({ externalId: 'upd-1', references: [KARLSRUHE_ID], officialSeverity: 4 });

    const cancel = update.replace('<msgType>Update</msgType>', '<msgType>Cancel</msgType>');
    const before = Date.now();
    expect(Date.parse(capToSourceItem(cancel)!.expiresAt!)).toBeGreaterThanOrEqual(before - 1000);

    expect(capToSourceItem(xml.replace('<status>Actual</status>', '<status>Exercise</status>'))).toBeNull();
    expect(capToSourceItem(xml.replace(/<polygon>[\s\S]*?<\/polygon>/g, ''))).toBeNull(); // nowhere to match
  });

  it('modes', () => {
    expect(parseDwdMode(undefined)).toBe('fallback');
    expect(parseDwdMode('ALWAYS')).toBe('always');
    expect(parseDwdMode('off')).toBe('off');
    expect(() => parseDwdMode('sometimes')).toThrow(/DWD_DIRECT/);
    expect(loadConfig({}).dwdDirect).toBe('fallback');
  });
});

describe('DWD open data: snapshot', () => {
  it('unzips the snapshot and builds items only for new messages; lists every current one', async () => {
    const fetched: string[] = [];
    const { feedKey, items, listedIds } = await fetchDwdSnapshot((id) => id !== HARZ_ID, async (url) => { fetched.push(url); return snapshot(); });
    expect(fetched).toEqual([DWD_LATEST_URL]);
    expect(feedKey).toBe(DWD_FEED_KEY);
    expect([...listedIds].sort()).toEqual([HARZ_ID, KARLSRUHE_ID].sort()); // the exercise and the readme don't count
    expect(items.map((i) => i.externalId)).toEqual([KARLSRUHE_ID]); // Harz was seen before
  });

  it('a broken or empty download is an error, never "all warnings lifted"', async () => {
    await expect(fetchDwdSnapshot(() => true, async () => Buffer.from('<html>maintenance</html>'))).rejects.toThrow(/zip/);
    const empty = Buffer.from('504b0506' + '00'.repeat(18), 'hex'); // a valid zip with no entries
    await expect(fetchDwdSnapshot(() => true, async () => empty)).rejects.toThrow(/empty/);
  });

  it('readZip handles stored and deflated entries', () => {
    const files = readZip(snapshot());
    expect(files.map((f) => f.name)).toContain('readme.txt');
    expect(files.find((f) => f.name === 'readme.txt')!.data.toString()).toBe('not a CAP file');
    expect(deflateRawSync(Buffer.from('x')).length).toBeGreaterThan(0);
  });
});

describe('DWD open data: end to end', () => {
  it('alerts people in the warned district, merges the update, and gives an all-clear when the warning disappears early', async () => {
    const store = new SqliteStore(':memory:');
    const push = new MemoryPushSender();
    let now = new Date('2026-11-18T17:30:00+01:00');
    const pipeline = new Pipeline({
      store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, now: () => now,
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 },
    });
    const { user: inKarlsruhe } = await store.createUser('ExponentPushToken[ka]');
    await store.updateLocation(inKarlsruhe.id, 49.0069, 8.4037);
    const { user: inBerlin } = await store.createUser('ExponentPushToken[b]');
    await store.updateLocation(inBerlin.id, 52.52, 13.405);

    const seen = async (id: string) => !(await store.hasSourceItem('dwd', id));
    const first = await fetchDwdSnapshot(seen, async () => snapshot());
    const r = await pipeline.ingest(first.items);
    expect(r.eventsCreated).toBe(2);
    expect(await store.alertsForUser(inBerlin.id)).toEqual([]);
    const [alert] = await store.alertsForUser(inKarlsruhe.id);
    expect(alert).toMatchObject({ official: true, sourceName: 'Deutscher Wetterdienst', category: 'weather' });
    expect(push.outbox.map((p) => p.token)).toEqual(['ExponentPushToken[ka]']);

    // An update that references the warning stays the same event.
    const upd = capToSourceItem(readFileSync(fxPath('dwd-cap-karlsruhe.xml'), 'utf8')
      .replace(`<identifier>${KARLSRUHE_ID}</identifier>`, '<identifier>upd-1</identifier>')
      .replace('<msgType>Alert</msgType>', `<msgType>Update</msgType>\n  <references>opendata@dwd.de,${KARLSRUHE_ID},2026-11-18T18:21:00+01:00</references>`))!;
    const r2 = await pipeline.ingest([upd]);
    expect(r2).toMatchObject({ eventsCreated: 0, eventsUpdated: 1 });

    // Next snapshot no longer lists Karlsruhe (nor its update), well before its end: lifted early → all-clear.
    now = new Date('2026-11-18T17:40:00+01:00');
    const lifted = await pipeline.reconcileFeed(DWD_FEED_KEY, new Set([HARZ_ID]));
    expect(lifted.ended).toBe(1);
    const alerts = await store.alertsForUser(inKarlsruhe.id);
    expect(alerts.length).toBe(2);
    await store.close();
  });
});
