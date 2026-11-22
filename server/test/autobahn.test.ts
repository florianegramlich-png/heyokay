import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOBAHN_URL, fetchAutobahn, isFullClosure, isFullClosureWarning, messageId, period, toSourceItem, type AutobahnMessage } from '../src/sources/autobahn.js';
import { describeSource } from '../src/sources/registry.js';
import { decide } from '../src/pipeline/rank.js';
import { recommendedAction } from '../src/pipeline/guidance.js';
import { normalizePrefs } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

// Real answers of verkehr.autobahn.de from 22 Nov 2026 for six motorways (long line geometries shortened).
const F = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'autobahn.json'), 'utf8')) as { roads: string[]; services: Record<string, Record<string, AutobahnMessage[]>> };
const NOW = new Date('2026-11-22T09:35:00Z');
const KOELN_NORD = { lat: 51.0032, lon: 6.9044 };
const fixtureGet = (fail: Record<string, number> = {}) => {
  const urls: string[] = [];
  const get = async (u: string) => {
    urls.push(u);
    const path = u.slice(AUTOBAHN_URL.length + 1).replace('/services/', '/');
    if (fail[path]) { fail[path]--; throw new Error(`${u} → HTTP 503`); }
    return path === '' ? { roads: [...F.roads, 'A1 ', 'B96'] } : F.services[path];
  };
  return { get, urls };
};
const msg = (road: string, kind: string, pred: (m: AutobahnMessage) => boolean) => F.services[`${road}/${kind}`][kind].find(pred)!;

describe('Autobahn closures', () => {
  it('reads start and end from the text, in Berlin time', () => {
    expect(period({ description: ['Zeitraum dieser Bauphase:', 'Beginn: 23.11.26 um 06:00 Uhr', 'Ende: 30.11.26 um 05:00 Uhr'] })).toEqual({ start: '2026-11-23T05:00:00.000Z', end: '2026-11-30T04:00:00.000Z' });
    expect(period({ description: ['Die Baustelle ist zu folgenden Zeiträumen gültig:', '24.11.26 21:00 bis zum 25.11.26 05:00 Uhr.'] })).toEqual({ start: '2026-11-24T20:00:00.000Z', end: '2026-11-25T04:00:00.000Z' });
    expect(period({ startTimestamp: '2026-11-21T18:58:00+01:00', description: ['Beginn: 21.11.26 um 18:58 Uhr'] })).toEqual({ start: '2026-11-21T17:58:00.000Z', end: null });
    expect(period({ description: ['Beginn: 01.07.26 um 06:00 Uhr'] }).start).toBe('2026-07-01T04:00:00.000Z');
  });

  it('only full closures: planned carriageway closures and "Vollsperrung" messages, never INRIX, never lorries-only', () => {
    const accident = msg('A1', 'warning', (m) => (m.description ?? []).some((l) => l.includes('Vollsperrung')));
    expect(accident.source).toBe('eva');
    expect(isFullClosureWarning(accident)).toBe(true);
    expect(isFullClosureWarning({ ...accident, source: 'inrix' })).toBe(false);
    expect(isFullClosureWarning({ ...accident, identifier: 'INRIX--vi-fbm.x' })).toBe(false);
    for (const m of F.services['A7/warning'].warning) expect(isFullClosureWarning(m), m.title).toBe(false); // jams, from INRIX
    expect(isFullClosure(msg('A36', 'closure', (m) => m.display_type === 'CLOSURE'))).toBe(true);
    expect(isFullClosure(msg('A4', 'closure', (m) => /Schwerlast/.test(m.title ?? '')))).toBe(false);
    expect(isFullClosure(msg('A100', 'closure', (m) => m.display_type === 'CLOSURE_ENTRY_EXIT'))).toBe(false); // a ramp
    expect(messageId('A1', accident)).toBe('autobahn:A1:NLR_2026_003711:75');
  });

  it('a calm item: "A1 gesperrt: Köln-Nord", direction, reason, since when; planned ones as "coming up"', () => {
    const accident = toSourceItem('A1', msg('A1', 'warning', isFullClosureWarning), 'warning', NOW)!;
    expect(accident).toMatchObject({
      source: 'autobahn', sourceName: 'Die Autobahn GmbH · Sperrungen', feedKey: 'autobahn:DE', official: true, structured: true,
      category: 'transit', hazard: 'road_closure', language: 'de', country: 'DE', officialSeverity: 2,
      title: 'A1 gesperrt: Köln-Nord', lat: 51.003210638503965, lon: 6.904373289500924, radiusM: 1000, expiresAt: '2026-11-22T21:35:00.000Z',
      body: 'Vollsperrung Richtung Euskirchen (Unfall), seit 21.11. 18:58 Uhr. Umleitung beachten. Quelle: Die Autobahn GmbH.',
    });
    expect(accident.onsetAt).toBeUndefined();
    const planned = toSourceItem('A36', msg('A36', 'closure', isFullClosure), 'closure', NOW)!;
    expect(planned).toMatchObject({
      title: 'A36 gesperrt: Quedlinburg Ost – Blankenburg Ost', officialSeverity: 1, onsetAt: '2026-11-23T07:00:00.000Z', expiresAt: '2026-11-26T12:00:00.000Z',
      body: 'Vollsperrung Richtung Vienenburg, 23.11. 08:00 bis 26.11. 13:00 Uhr (Baustelle). Umleitung beachten. Quelle: Die Autobahn GmbH.',
    });
    expect(planned.title.length).toBeLessThanOrEqual(50);
    expect(toSourceItem('A36', msg('A36', 'closure', isFullClosure), 'closure', new Date('2026-11-27T00:00:00Z'))).toBeNull(); // over
  });

  it('every motorway, 4 at a time; new closures only, but everything still listed counts as listed; a road failing twice fails the poll', async () => {
    const { get, urls } = fixtureGet();
    const r = await fetchAutobahn((id) => id !== 'autobahn:A4:2024-055330:46', get, { now: NOW });
    expect(urls[0]).toBe(`${AUTOBAHN_URL}/`);
    expect(urls).toHaveLength(1 + 6 * 2); // "A1 " is the same road, B96 is not a motorway
    expect(r.feedKey).toBe('autobahn:DE');
    expect(r.items.map((i) => i.externalId)).toEqual(['autobahn:A1:NLR_2026_003711:75', 'autobahn:A36:2026-059165:27']);
    // Long-running closures we don't announce are still "listed", so they never get a false all-clear.
    expect(r.listedIds.size).toBeGreaterThan(10);
    expect(r.listedIds.has('autobahn:A4:2024-055330:46')).toBe(true);
    // One failure is retried; two fail the poll instead of looking like "all lifted".
    expect((await fetchAutobahn(() => true, fixtureGet({ 'A6/closure': 1 }).get, { now: NOW })).items).toHaveLength(3);
    await expect(fetchAutobahn(() => true, fixtureGet({ 'A6/closure': 2 }).get, { now: NOW })).rejects.toThrow(/503/);
    await expect(fetchAutobahn(() => true, async () => ({}), { now: NOW })).rejects.toThrow(/no list of roads/);
  });

  it('feed by default; a push only near a saved place, and only for an actual closure (not a planned one)', () => {
    const base = { id: 'u', tokenHash: '', pushToken: 'x', lat: null, lon: null, locationUpdatedAt: null, createdAt: '' };
    const user = { ...base, prefs: normalizePrefs({ quietHours: null }) };
    const ctx = (matchedPlace: string | null) => ({ now: NOW, pushesLast24h: 0, feedback: {}, matchedPlace });
    const accident = { category: 'transit', severity: 2, official: true, hazard: 'road_closure' } as any;
    expect(decide(user, accident, ctx(null))).toEqual({ delivery: 'feed', reason: 'road closure: push only near a saved place' });
    expect(decide(user, accident, ctx('Arbeit'))).toEqual({ delivery: 'push', reason: 'relevant' });
    expect(decide(user, { ...accident, severity: 1 }, ctx('Arbeit')).delivery).toBe('feed');
    expect(recommendedAction('transit', 1, 'de', 'road_closure')).toMatch(/^Mehr Zeit einplanen und die ausgeschilderte Umleitung/);
    expect(recommendedAction('transit', 2, 'de', 'road_closure')).toMatch(/Rettungsgasse/);
    expect(recommendedAction('transit', 2, 'en', 'road_closure')).toMatch(/^Avoid this stretch/);
    expect(describeSource('autobahn:DE')).toMatchObject({ name: 'Die Autobahn GmbH · Sperrungen', country: 'DE', official: true, category: 'transit' });
    expect(loadConfig({}).autobahn).toBe(AUTOBAHN_URL);
    expect(loadConfig({ AUTOBAHN_URL: 'off' }).autobahn).toBeNull();
  });
});

describe.each(storeBackends())('Autobahn closures end to end ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('A1 closed at Köln-Nord: a push for the saved place "Arbeit", the feed for someone driving by; lifted → all-clear', async () => {
    const push = new MemoryPushSender();
    let now = NOW;
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: loadConfig({}), now: () => now });
    const commuter = (await store.createUser('ExponentPushToken[work]', { language: 'de', quietHours: null } as any)).user;
    await store.addPlace(commuter.id, 'Arbeit', KOELN_NORD.lat + 0.005, KOELN_NORD.lon, 1000);
    const passing = (await store.createUser('ExponentPushToken[car]', { language: 'de', quietHours: null } as any)).user;
    await store.updateLocation(passing.id, KOELN_NORD.lat, KOELN_NORD.lon + 0.01);
    const far = (await store.createUser('ExponentPushToken[far]', { language: 'de' } as any)).user;
    await store.updateLocation(far.id, 52.52, 13.405);

    const r = await fetchAutobahn(() => true, fixtureGet().get, { now: NOW });
    await pipeline.ingest(r.items.filter((i) => i.externalId.startsWith('autobahn:A1:')));
    const [work] = await store.alertsForUser(commuter.id);
    expect(work).toMatchObject({ category: 'transit', delivery: 'push', title: 'Arbeit: A1 gesperrt: Köln-Nord', matchedPlace: 'Arbeit' });
    expect(work.action).toMatch(/Rettungsgasse/);
    const [car] = await store.alertsForUser(passing.id);
    expect(car).toMatchObject({ delivery: 'feed', reason: 'road closure: push only near a saved place' });
    expect(await store.alertsForUser(far.id)).toEqual([]);
    expect(push.outbox.map((m) => m.token)).toEqual(['ExponentPushToken[work]']);

    // An hour later the A1 message is gone from the list: lifted early.
    now = new Date(NOW.getTime() + 3600_000);
    const lifted = await pipeline.reconcileFeed(r.feedKey, new Set([...r.listedIds].filter((id) => !id.startsWith('autobahn:A1:'))));
    expect(lifted.ended).toBe(1);
    expect((await store.alertsForUser(commuter.id))[0]).toMatchObject({ kind: 'all_clear' });
    expect(push.outbox).toHaveLength(2);
  });
});
