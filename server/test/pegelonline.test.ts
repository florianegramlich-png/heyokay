import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchPegelonline, gaugeItem, gaugeState, niceName, type PegelStation } from '../src/sources/pegelonline.js';
import { describeSource } from '../src/sources/registry.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';

// Real PEGELONLINE stations (live format, 2026-11-19). States edited for the cases:
// Celle normal · Templin UP above MHW (live) · Dresden above HSW · Köln out of date ·
// Dordrecht without coordinates · Tiel (NL), reading from 3 Nov.
const STATIONS = JSON.parse(readFileSync(new URL('./fixtures/pegelonline-stations.json', import.meta.url), 'utf8')) as PegelStation[];
const NOW = new Date('2026-11-19T23:40:00+01:00');
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
const byName = (n: string) => structuredClone(STATIONS.find((s) => s.shortname === n)!);
const withState = (s: PegelStation, mhw: string, hsw = 'normal', ts?: string) => {
  const m = s.timeseries![0].currentMeasurement!;
  Object.assign(m, { stateMnwMhw: mhw, stateNswHsw: hsw }, ts ? { timestamp: ts } : {});
  return s;
};

describe('river gauges (PEGELONLINE)', () => {
  it('reads the state: above MHW → 2, above HSW → 1; old or out-of-date readings are unknown', () => {
    expect(gaugeState(byName('CELLE'), NOW)).toEqual({ kind: 'normal' });
    expect(gaugeState(byName('TEMPLIN UP'), NOW)).toEqual({ kind: 'high', level: 2 });
    expect(gaugeState(byName('DRESDEN'), NOW)).toEqual({ kind: 'high', level: 1 });
    expect(gaugeState(byName('KÖLN'), NOW)).toEqual({ kind: 'unknown' });
    expect(gaugeState(byName('TIEL'), NOW)).toEqual({ kind: 'unknown' }); // reading from 3 Nov
  });

  it('names read naturally', () => {
    expect(niceName('FRANKFURT AM MAIN')).toBe('Frankfurt am Main');
    expect(niceName('TEMPLINER GEWÄSSER')).toBe('Templiner Gewässer');
    expect(niceName('TEMPLIN UP')).toBe('Templin UP');
    expect(niceName('KÖLN-MÜLHEIM')).toBe('Köln-Mülheim');
  });

  it('maps the feed: high gauges in Germany only, calm German text, gauge page link', async () => {
    const r = await fetchPegelonline(() => true, async () => STATIONS, { now: NOW });
    expect(r.feedKey).toBe('pegelonline:DE');
    expect(r.items.map((i) => [i.title, i.officialSeverity])).toEqual([
      ['Hochwasser: Templiner Gewässer bei Templin UP', 2],
      ['Erhöhter Wasserstand: Elbe bei Dresden', 1],
    ]);
    expect(r.items[1]).toMatchObject({
      source: 'pegelonline', hazard: 'flood', category: 'weather', official: true, structured: true,
      language: 'de', country: 'DE', radiusM: 5000, areaName: 'Elbe, Dresden',
      url: 'https://www.pegelonline.wsv.de/gast/stammdaten?pegelnr=501060',
    });
    for (const i of r.items) { expect(i.title.length).toBeLessThanOrEqual(50); expect(i.body.length).toBeLessThanOrEqual(100); }
    expect(r.items[1].body).toBe('Pegel Dresden: 83 cm (23:30 Uhr), über dem höchsten Schifffahrtswasserstand.');
    // Köln has no usable reading: whatever runs there is kept, not lifted.
    expect([...r.listedIds].filter((x) => x.includes('a6ee8177'))).toHaveLength(4);
    // A Dutch gauge never makes a German alert, even when high and current.
    expect(gaugeItem(withState(byName('TIEL'), 'high', 'normal', '2026-11-19T23:30:00+01:00'), NOW)).toBeNull();
    expect(describeSource('pegelonline:DE')).toMatchObject({ country: 'DE', official: true, fallback: 'nina:lhp' });
  });
});

describe.each(storeBackends())('river gauges through the pipeline ($name)', (backend) => {
  let store: Store, push: MemoryPushSender, pipeline: Pipeline, clock: Date;
  const user = async (lat: number, lon: number) => {
    const { user } = await store.createUser('ExponentPushToken[p]', { language: 'de', timezone: 'Europe/Berlin', quietHours: null });
    await store.updateLocation(user.id, lat, lon);
    return user;
  };
  const poll = async (stations: PegelStation[]) => {
    const r = await fetchPegelonline(async (id) => !(await store.hasSourceItem('pegelonline', id)), async () => stations, { now: clock });
    const ing = await pipeline.ingest(r.items);
    const rec = await pipeline.reconcileFeed(r.feedKey, r.listedIds);
    return { ...ing, lifted: rec.ended };
  };

  beforeEach(async () => {
    clock = NOW;
    store = await backend.make();
    push = new MemoryPushSender();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: cfg, now: () => clock });
  });
  afterEach(async () => { await store.close(); });

  it('high water in the feed, flooding may push, far away nothing; escalation, next day, all-clear', async () => {
    const dresden = await user(51.052, 13.741); // Altstadt, by the Elbe
    const templin = await user(53.118, 13.50);
    const berlin = await user(52.52, 13.405);

    await poll(STATIONS);
    const [d] = await store.alertsForUser(dresden.id);
    expect(d).toMatchObject({ title: 'Erhöhter Wasserstand: Elbe bei Dresden', delivery: 'feed' });
    expect(d.action).toBe('Ufer und Uferwege meiden. Fahrzeuge aus tief liegenden Bereichen holen.');
    const [t] = await store.alertsForUser(templin.id);
    expect(t).toMatchObject({ title: 'Hochwasser: Templiner Gewässer bei Templin UP', delivery: 'push' });
    expect(await store.alertsForUser(berlin.id)).toHaveLength(0);

    // Elbe rises above MHW: same event, escalated. Templin falls back to normal: all-clear.
    clock = new Date(NOW.getTime() + 15 * 60_000);
    const ts = '2026-11-19T23:45:00+01:00';
    const next = [withState(byName('DRESDEN'), 'high', 'high', ts), withState(byName('TEMPLIN UP'), 'normal', 'unknown', ts), byName('KÖLN')];
    const r = await poll(next);
    expect(r.eventsCreated).toBe(0);
    expect(r.lifted).toBe(1);
    expect((await store.alertsForUser(dresden.id))[0].title).toBe('Hochwasser: Elbe bei Dresden');
    expect((await store.alertsForUser(templin.id)).map((a) => a.kind)).toEqual(['all_clear', 'new']);

    // Past midnight, still high: no new alert, nothing lifted.
    clock = new Date('2026-11-20T00:30:00+01:00');
    const before = (await store.alertsForUser(dresden.id)).length;
    const r2 = await poll([withState(byName('DRESDEN'), 'high', 'high', '2026-11-20T00:15:00+01:00')]);
    expect(r2).toMatchObject({ eventsCreated: 0, lifted: 0 });
    expect(await store.alertsForUser(dresden.id)).toHaveLength(before);
  });
});
