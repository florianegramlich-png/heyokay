import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { FEUERWEHR_BERLIN_AREA, FEUERWEHR_BERLIN_URL, fetchFeuerwehrBerlin, parseReports } from '../src/sources/feuerwehr-berlin.js';
import { loadConfig } from '../src/config.js';
import { SqliteStore } from '../src/db.js';
import type { StructuredLLM } from '../src/llm.js';
import type { Geocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

const feed = readFileSync(join(import.meta.dirname, 'fixtures', 'feuerwehr-berlin-einsaetze.xml'), 'utf8');

describe('Berliner Feuerwehr incident reports', () => {
  it('reads street and district from the report, whatever the colon placement', () => {
    const reports = parseReports(feed);
    expect(reports).toHaveLength(5);
    expect(reports.map((r) => [r.street, r.district])).toEqual([
      ['Kölner Damm', 'Gropiusstadt'],
      ['Peter Weiss Gasse', 'Hellersdorf'],
      ['Konrad-Wolf-Straße', 'Alt-Hohenschönhausen'],
      ['Konrad-Wolf-Straße', 'Alt-Hohenschönhausen'], // "<strong>Ortsteil</strong>: …"
      ['Seidenschwanzstraße', 'Mahlsdorf'], // "<strong>Straße</strong>: …", "<strong>Ortsteil: </strong>…"
    ]);
    expect(reports[0]).toMatchObject({ id: '5576', title: 'Brand mehrerer Fahrzeuge in Gropiusstadt', publishedAt: '2026-11-15T00:57:00.000Z' });
  });

  it('keeps the situation and drops units, partners, photo credit and initials', () => {
    const [r] = parseReports(feed);
    expect(r.text).toContain('zehn brennende Fahrzeuge');
    expect(r.text).not.toMatch(/Eingesetzt|LHF|Vor Ort:|Bildmaterial|\(mw\)/);
    expect(r.text).not.toContain('&nbsp;');
  });

  it('builds items with the place first, only for new reports', async () => {
    const urls: string[] = [];
    const items = await fetchFeuerwehrBerlin((id) => id !== 'feuerwehr-berlin:5573', async (url) => { urls.push(url); return feed; });
    expect(urls).toEqual([FEUERWEHR_BERLIN_URL]);
    expect(items.map((i) => i.externalId)).toEqual(['feuerwehr-berlin:5576', 'feuerwehr-berlin:5571', 'feuerwehr-berlin:5572', 'feuerwehr-berlin:5570']);
    expect(items[0]).toMatchObject({ source: 'rss', sourceName: 'Berliner Feuerwehr', official: false, category: 'public_safety', language: 'de' });
    expect(items[0].body.startsWith('Ort: Kölner Damm, Gropiusstadt, Berlin\n\n')).toBe(true);
    expect(items[0].url).toBe('https://www.berliner-feuerwehr.de/aktuelles/einsaetze/brand-mehrerer-fahrzeuge-in-gropiusstadt-5576/');
  });

  it('is on by default and can be turned off', () => {
    expect(loadConfig({}).feuerwehrBerlin).toBe(true);
    expect(loadConfig({ FEUERWEHR_BERLIN: 'off' }).feuerwehrBerlin).toBe(false);
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

describe('Berliner Feuerwehr: end to end', () => {
  it('a gas leak report reaches people nearby while it is current', async () => {
    const items = (await fetchFeuerwehrBerlin(() => true, async () => feed)).filter((i) => i.externalId === 'feuerwehr-berlin:5571');
    const llm = new ScriptedLLM([{
      isCurrentSafetyEvent: true, category: 'public_safety', severity: 3, confidence: 0.85,
      title: 'Gasaustritt in Alt-Hohenschönhausen', summary: 'Die Feuerwehr ist wegen eines Gasaustritts in der Konrad-Wolf-Straße im Einsatz.',
      place: 'Konrad-Wolf-Straße, Alt-Hohenschönhausen, Berlin', radiusM: 300, endsAt: null,
    }]);
    const spot = { name: 'Konrad-Wolf-Straße', lat: 52.5455, lon: 13.4996, radiusM: 200 };
    const geocoder: Geocoder = { geocode: async (p) => (/konrad-wolf/i.test(p) ? spot : null) };
    const store = new SqliteStore(':memory:');
    const push = new MemoryPushSender();
    const pipeline = new Pipeline({
      store, llm, geocoder, push, now: () => new Date('2026-11-10T13:00:00+01:00'),
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 },
    });
    const { user } = await store.createUser('ExponentPushToken[hsh]');
    await store.updateLocation(user.id, 52.548, 13.502);

    const r = await pipeline.ingest(items, FEUERWEHR_BERLIN_AREA);
    expect(r).toMatchObject({ eventsCreated: 1, sentToReview: 0, alertsCreated: 1 });
    expect(llm.prompts[0]).toContain('Ort: Konrad-Wolf-Straße, Alt-Hohenschönhausen, Berlin');
    const [alert] = await store.alertsForUser(user.id);
    expect(alert.sourceName).toBe('Berliner Feuerwehr');
    await store.close();
  });
});
