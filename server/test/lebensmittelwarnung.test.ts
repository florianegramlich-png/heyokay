import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEBENSMITTELWARNUNG_URL, fetchRecalls, fields, parseRecalls, toSourceItem } from '../src/sources/lebensmittelwarnung.js';
import { DE_STATES } from '../src/data/de-states.js';
import { distanceToAreasM } from '../src/geo.js';
import { describeSource } from '../src/sources/registry.js';
import { decide } from '../src/pipeline/rank.js';
import { recommendedAction } from '../src/pipeline/guidance.js';
import { CATEGORIES, DEFAULT_PREFS, normalizePrefs } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

const FEED = readFileSync(join(import.meta.dirname, 'fixtures', 'lebensmittelwarnung.rss'), 'utf8');
const NOW = new Date('2026-11-21T18:00:00+01:00');
const HAMBURG = { lat: 53.55, lon: 9.99 };
const MUENCHEN = { lat: 48.137, lon: 11.575 };
const BERLIN = { lat: 52.52, lon: 13.405 };
const inside = (areas: [number, number][][], p: { lat: number; lon: number }) => distanceToAreasM(p.lat, p.lon, areas) === 0;

describe('lebensmittelwarnung.de recalls', () => {
  it('reads the live feed: product, reason, best-before, batch, maker and Länder', () => {
    const recalls = parseRecalls(FEED);
    expect(recalls).toHaveLength(7);
    expect(recalls[1]).toEqual({
      id: '261120_21_NI_Wildsalami', title: 'Wildsalami',
      url: 'https://www.lebensmittelwarnung.de/___lebensmittelwarnung.de/Meldungen/2026/11_November/261120_21_NI_Wildsalami/261120_21_NI_Wildsalami.html',
      publishedAt: '2026-11-20T12:56:00.000Z', product: 'Wildsalami', reason: 'Krankheitserreger',
      bestBefore: 'Mindesthaltbarkeitsdatum: 02.02.2027', batch: null, maker: 'Wildspezialitaeten aus Welle e.K.',
      states: ['Hamburg', 'Niedersachsen'],
    });
    expect(recalls[0].states).toHaveLength(16);
    // "Sachsen" is not read into "Sachsen-Anhalt" and back.
    expect(recalls[4].states).toContain('Sachsen-Anhalt');
    expect(recalls[4].states).toContain('Sachsen');
    expect(recalls[4].states).not.toContain('Bremen');
    expect(recalls[4].states).not.toContain('Saarland');
    expect(fields('<b>Grund der Meldung:</b>   Fremdkörper<br/><b>Kontakt:</b> A<br/>B<br/>')).toEqual({ 'Grund der Meldung': 'Fremdkörper', Kontakt: 'A\nB' });
  });

  it('becomes a calm, structured recall over the outlines of the Länder it names', () => {
    const item = toSourceItem(parseRecalls(FEED)[1])!;
    expect(item).toMatchObject({
      source: 'lebensmittelwarnung', externalId: 'lebensmittelwarnung:261120_21_NI_Wildsalami', official: true, structured: true,
      category: 'recall', hazard: 'recall', country: 'DE', language: 'de', officialSeverity: 1,
      title: 'Rückruf: Wildsalami', areaName: 'Hamburg, Niedersachsen', expiresAt: '2026-12-04T12:56:00.000Z',
    });
    expect(item.body).toBe('Grund: Krankheitserreger. Verkauft in: Hamburg, Niedersachsen. Mindesthaltbarkeitsdatum: 02.02.2027. Hersteller/Händler: Wildspezialitaeten aus Welle e.K.');
    expect(inside(item.areas!, HAMBURG)).toBe(true);
    expect(inside(item.areas!, MUENCHEN)).toBe(false);
    const all = toSourceItem(parseRecalls(FEED)[0])!;
    expect(all).toMatchObject({ title: 'Rückruf: Parmentine Speisekartoffeln rot', areaName: 'Deutschland' });
    expect(all.body).toContain('Verkauft in: ganz Deutschland.');
    for (const p of [HAMBURG, MUENCHEN, BERLIN, { lat: 54.43, lon: 13.5 } /* Rügen */, { lat: 47.6, lon: 9.6 } /* Bodensee */]) {
      expect(inside(all.areas!, p)).toBe(true);
    }
    expect(inside(all.areas!, { lat: 48.86, lon: 2.35 })).toBe(false); // Paris
    expect(toSourceItem({ ...parseRecalls(FEED)[1], states: [] })).toBeNull();
  });

  it('Länder outlines: 16, each containing its capital', () => {
    expect(Object.keys(DE_STATES)).toHaveLength(16);
    const capitals: Record<string, [number, number]> = {
      'Baden-Württemberg': [48.78, 9.18], Bayern: [48.14, 11.58], Berlin: [52.52, 13.4], Brandenburg: [52.4, 13.06], Bremen: [53.08, 8.8],
      Hamburg: [53.55, 9.99], Hessen: [50.08, 8.24], 'Mecklenburg-Vorpommern': [53.63, 11.41], Niedersachsen: [52.37, 9.73],
      'Nordrhein-Westfalen': [51.23, 6.78], 'Rheinland-Pfalz': [50.0, 8.27], Saarland: [49.24, 6.99], Sachsen: [51.05, 13.74],
      'Sachsen-Anhalt': [52.12, 11.63], 'Schleswig-Holstein': [54.32, 10.12], Thüringen: [50.98, 11.03],
    };
    for (const [state, [lat, lon]] of Object.entries(capitals)) expect(inside(DE_STATES[state].rings, { lat, lon }), state).toBe(true);
    expect(inside(DE_STATES.Bayern.rings, HAMBURG)).toBe(false);
  });

  it('only warnings from the last 7 days; a changed page fails instead of looking like "no recalls"', async () => {
    const fetched: string[] = [];
    const get = async (u: string) => { fetched.push(u); return FEED; };
    const items = await fetchRecalls((id) => id !== 'lebensmittelwarnung:261118_Leberwurst', get, { now: NOW });
    expect(fetched).toEqual([LEBENSMITTELWARNUNG_URL]);
    expect(items.map((i) => i.title)).toEqual([
      'Rückruf: Parmentine Speisekartoffeln rot', 'Rückruf: Wildsalami', 'Rückruf: Appetiter Streichmettwurst fein',
      'Rückruf: Leberwurst fein 100 Gramm', 'Rückruf: rieker Antistress Damensandale rot/braun',
    ]);
    expect(await fetchRecalls(() => false, get, { now: NOW })).toEqual([]);
    await expect(fetchRecalls(() => true, async () => '<html>Wartungsarbeiten</html>', { now: NOW })).rejects.toThrow(/not an RSS feed/);
  });

  it('is never a push, on by default (also for people who saved settings before), with recall advice', () => {
    const base = { id: 'u', tokenHash: '', pushToken: 'x', lat: null, lon: null, locationUpdatedAt: null, createdAt: '' };
    const ctx = { now: NOW, pushesLast24h: 0, feedback: {} };
    const user = { ...base, prefs: normalizePrefs({ quietHours: null }) };
    expect(decide(user, { category: 'recall', severity: 1, official: true } as any, ctx)).toEqual({ delivery: 'feed', reason: 'recall: feed only' });
    expect(decide(user, { category: 'recall', severity: 5, official: true } as any, ctx).delivery).toBe('push'); // official extreme warnings still break through
    expect(CATEGORIES).toContain('recall');
    expect(DEFAULT_PREFS.categories).toContain('recall');
    expect(normalizePrefs({ categories: ['weather'], knownCategories: ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure', 'technology'] }).categories).toEqual(['weather', 'recall']);
    expect(recommendedAction('recall', 1, 'de', 'recall')).toMatch(/^Produkt nicht verwenden\. Im Geschäft zurückgeben/);
    expect(recommendedAction('recall', 1, 'en', 'recall')).toMatch(/^Don't use the product/);
    expect(describeSource('lebensmittelwarnung:DE')).toMatchObject({ country: 'DE', official: true, category: 'recall' });
    expect(loadConfig({}).lebensmittelwarnung).toBe(LEBENSMITTELWARNUNG_URL);
    expect(loadConfig({ LEBENSMITTELWARNUNG_URL: 'off' }).lebensmittelwarnung).toBeNull();
  });
});

describe.each(storeBackends())('recalls end to end ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('a salami recall for Hamburg and Niedersachsen: in the feed in Hamburg, nothing in München, never a push', async () => {
    const push = new MemoryPushSender();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: loadConfig({}), now: () => NOW });
    const hh = (await store.createUser('ExponentPushToken[hh]')).user;
    await store.updateLocation(hh.id, HAMBURG.lat, HAMBURG.lon);
    const muc = (await store.createUser('ExponentPushToken[muc]')).user;
    await store.updateLocation(muc.id, MUENCHEN.lat, MUENCHEN.lon);

    const items = (await fetchRecalls(() => true, async () => FEED, { now: NOW })).filter((i) => i.title === 'Rückruf: Wildsalami');
    const r = await pipeline.ingest(items);
    expect(r).toMatchObject({ eventsCreated: 1, sentToReview: 0, alertsCreated: 1 });
    const [alert] = await store.alertsForUser(hh.id);
    expect(alert).toMatchObject({ category: 'recall', delivery: 'feed', title: 'Rückruf: Wildsalami' });
    expect(alert.action).toMatch(/^Produkt nicht verwenden/);
    expect(await store.alertsForUser(muc.id)).toEqual([]);
    expect(push.outbox).toEqual([]);
  });

  it('two recalls on the same day stay two alerts (they share the country centre, so must never merge)', async () => {
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}), now: () => NOW });
    const hh = (await store.createUser('ExponentPushToken[hh2]')).user;
    await store.updateLocation(hh.id, HAMBURG.lat, HAMBURG.lon);
    // Two nationwide recalls published in the same hour.
    const [a, b] = (await fetchRecalls(() => true, async () => FEED, { now: NOW })).filter((i) => i.areaName === 'Deutschland' || i.title === 'Rückruf: Wildsalami');
    const r = await pipeline.ingest([a, { ...b, publishedAt: a.publishedAt }]);
    expect(r).toMatchObject({ eventsCreated: 2, eventsUpdated: 0 });
    expect(await store.alertsForUser(hh.id)).toHaveLength(2);
  });
});
