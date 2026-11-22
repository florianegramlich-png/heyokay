import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  POLIZEI_BERLIN_AREA, POLIZEI_BERLIN_URL, fetchPolizeiBerlin, isNeverAnAlertBerlin, parseBerlinArticle, parseBerlinFeed,
} from '../src/sources/polizei-berlin.js';
import { describeSource } from '../src/sources/registry.js';
import { loadConfig } from '../src/config.js';
import { SqliteStore } from '../src/db.js';
import type { StructuredLLM } from '../src/llm.js';
import type { Geocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

const fx = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8');
const FEED = fx('polizei-berlin.rss');
const ROBBERY_URL = 'https://www.berlin.de/polizei/polizeimeldungen/pressemitteilung.1742154.php';
const ROBBERY = fx('polizei-berlin-1742154.html');
const NOW = new Date('2026-11-21T17:00:00+01:00');

/** Serves the fixtures by URL; other release pages give a page without a release. */
function fakeWeb() {
  const fetched: string[] = [];
  const get = async (url: string) => {
    fetched.push(url);
    if (url === POLIZEI_BERLIN_URL) return FEED;
    if (url === ROBBERY_URL) return ROBBERY;
    return '<html><body>Not found</body></html>';
  };
  return { get, fetched };
}

describe('Polizei Berlin press releases (berlin.de)', () => {
  it('reads the live feed: id, title, link, time', () => {
    const entries = parseBerlinFeed(FEED);
    expect(entries).toHaveLength(7);
    expect(entries[2]).toEqual({
      id: '1742154', title: 'Raubüberfall auf Restaurant', url: ROBBERY_URL, publishedAt: '2026-11-21T10:54:15.000Z',
    });
  });

  it('reads district and text from a release page, without the release number or the contact box', () => {
    const a = parseBerlinArticle(ROBBERY)!;
    expect(a.district).toBe('Steglitz-Zehlendorf');
    expect(a.text.startsWith('In der vergangenen Nacht wurde ein Restaurant in Dahlem überfallen.')).toBe(true);
    expect(a.text).toContain('Clayallee');
    expect(a.text).not.toMatch(/Nr\. 1557|Platz der Luftbrücke|Pressestelle/);
    expect(parseBerlinArticle('<html>nothing</html>')).toBeNull();
  });

  it('drops appeals about the dead, people found again, verdicts and prevention campaigns', () => {
    const dropped = parseBerlinFeed(FEED).filter((e) => isNeverAnAlertBerlin(e.title)).map((e) => e.title);
    expect(dropped).toEqual([
      'Unbekannter Toter – die Polizei bittet um Ihre Mithilfe',
      'Gemeinsame Präventionsaktion im ÖPNV im Advent 2026',
      'Hochschwangere Frau und ihre beiden Kinder wieder da',
      'Erstes Urteil gegen zwei Männer nach Schüssen in der Ebersstraße',
    ]);
    expect(isNeverAnAlertBerlin('Vermisste Seniorin – wer hat sie gesehen?')).toBe(true); // shared Presseportal filter
    expect(isNeverAnAlertBerlin('Schüsse auf Imbiss')).toBe(false);
  });

  it('fetches only new, recent releases; one without a readable page waits for the next poll', async () => {
    const web = fakeWeb();
    const items = await fetchPolizeiBerlin((id) => id !== 'polizei-berlin:1742166', web.get, { now: NOW });
    // 3 from today: one already seen, one whose page isn't readable (skipped), the robbery.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'rss', sourceName: 'Polizei Berlin', externalId: 'polizei-berlin:1742154', official: false,
      category: 'crime', language: 'de', country: 'DE', title: 'Raubüberfall auf Restaurant', url: ROBBERY_URL,
    });
    expect(items[0].body.startsWith('Ort: Steglitz-Zehlendorf, Berlin\n\nIn der vergangenen Nacht')).toBe(true);
    expect(web.fetched.filter((u) => u.includes('pressemitteilung'))).toHaveLength(2); // nothing old, nothing dropped, nothing seen
    expect(await fetchPolizeiBerlin(() => true, web.get, { now: NOW, maxArticles: 0 })).toEqual([]);
  });

  it('is on by default, can be turned off, and shows on the Alert Desk as a police source', () => {
    expect(loadConfig({}).polizeiBerlin).toBe(true);
    expect(loadConfig({ POLIZEI_BERLIN: 'off' }).polizeiBerlin).toBe(false);
    expect(describeSource('polizei-berlin')).toMatchObject({ name: 'Polizei Berlin', country: 'DE', category: 'police' });
  });
});

class ScriptedLLM implements StructuredLLM {
  readonly enabled = true;
  prompts: string[] = [];
  constructor(private queue: unknown[]) {}
  async generate<T extends z.ZodType>(_s: string, user: string, schema: T) {
    this.prompts.push(user);
    const next = this.queue.shift();
    return next === undefined ? null : (schema.parse(next) as z.infer<T>);
  }
}

describe('Polizei Berlin: end to end', () => {
  it('a robbery in Dahlem reaches people nearby as a police alert, not people across town', async () => {
    const items = await fetchPolizeiBerlin(() => true, fakeWeb().get, { now: NOW });
    const llm = new ScriptedLLM([{
      isCurrentSafetyEvent: true, category: 'crime', severity: 2, confidence: 0.85,
      title: 'Raubüberfall auf Restaurant in Dahlem', summary: 'Drei maskierte Männer haben in der Nacht ein Restaurant an der Clayallee überfallen. Niemand wurde verletzt.',
      place: 'Clayallee, Dahlem, Berlin', radiusM: 500, endsAt: null,
    }]);
    const spot = { name: 'Clayallee', lat: 52.4545, lon: 13.2855, radiusM: 300 };
    const geocoder: Geocoder = { geocode: async (p) => (/clayallee/i.test(p) ? spot : null) };
    const store = new SqliteStore(':memory:');
    const pipeline = new Pipeline({
      store, llm, geocoder, push: new MemoryPushSender(), now: () => NOW,
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 },
    });
    const near = (await store.createUser('ExponentPushToken[dahlem]')).user;
    await store.updateLocation(near.id, 52.457, 13.29);
    const far = (await store.createUser('ExponentPushToken[pankow]')).user;
    await store.updateLocation(far.id, 52.569, 13.402);

    const r = await pipeline.ingest(items, POLIZEI_BERLIN_AREA);
    expect(r).toMatchObject({ eventsCreated: 1, sentToReview: 0 });
    expect(llm.prompts[0]).toContain('Ort: Steglitz-Zehlendorf, Berlin');
    const [alert] = await store.alertsForUser(near.id);
    expect(alert).toMatchObject({ sourceName: 'Polizei Berlin', category: 'crime' });
    expect(await store.alertsForUser(far.id)).toEqual([]);
    await store.close();
  });
});
