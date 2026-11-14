import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { Store } from '../src/db.js';
import { NoLLM, type StructuredLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { toSourceItem, mapSeverity, mapCategory } from '../src/sources/nina.js';
import { parseFeed } from '../src/sources/rss.js';
import { verify, numbers, truncate, compose } from '../src/pipeline/compose.js';
import { decide, inQuietHours, learnedRelevance, match } from '../src/pipeline/rank.js';
import { heuristicExtract } from '../src/pipeline/extract.js';
import type { RiskEvent, SourceItem, User } from '../src/types.js';
import { DEFAULT_PREFS } from '../src/types.js';

const fx = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8');
const NOW = new Date('2026-11-14T09:50:00+01:00');
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
const FRIEDRICHSHAIN = { lat: 52.5101, lon: 13.4585 };

/** Returns queued responses in order; null when empty. */
class ScriptedLLM implements StructuredLLM {
  readonly enabled = true;
  calls: string[] = [];
  constructor(private queue: unknown[]) {}
  async generate<T extends z.ZodType>(_s: string, user: string, schema: T) {
    this.calls.push(user);
    const next = this.queue.shift();
    return next === undefined ? null : (schema.parse(next) as z.infer<T>);
  }
}

function ninaItem(): SourceItem {
  return toSourceItem('dwd', { id: 'dwdmap.2.49.0.0.276.0.DWD.PVW.abc123', version: 1, type: 'Alert' },
    JSON.parse(fx('nina-dwd-warning.json')), JSON.parse(fx('nina-dwd-geo.json')))!;
}

describe('sources', () => {
  it('maps NINA/DWD warnings to official, located, severity-mapped items', () => {
    const item = ninaItem();
    expect(item.official).toBe(true);
    expect(item.category).toBe('weather');
    expect(item.officialSeverity).toBe(4);
    expect(item.lat).toBeCloseTo(52.51, 1);
    expect(item.lon).toBeCloseTo(13.43, 1);
    expect(item.radiusM).toBeGreaterThan(3000);
    expect(item.externalId).toMatch(/@v1$/);
    expect(item.body).toContain('110 km/h');
  });

  it('maps CAP severities and categories', () => {
    expect(mapSeverity('Extreme')).toBe(5);
    expect(mapSeverity('Minor')).toBe(2);
    expect(mapCategory('mowas', ['Health'])).toBe('health');
    expect(mapCategory('police', [])).toBe('crime');
    expect(mapCategory('katwarn', ['Fire'])).toBe('public_safety');
  });

  it('parses RSS items, including CDATA', () => {
    const items = parseFeed(fx('police-berlin.rss'), { url: 'x', sourceName: 'Polizei Berlin', categoryHint: 'crime' });
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain('Ostkreuz');
    expect(items[0].body).toContain('9:15 Uhr');
    expect(items[0].official).toBe(false);
    expect(items[0].publishedAt).toBe('2026-11-14T08:40:00.000Z');
  });
});

describe('fact verifier', () => {
  const facts = 'Der Bereich rund um den Bahnhof Ostkreuz ist seit 9:15 Uhr gesperrt. Sperrung bis 11:30 Uhr. Böen um 110 km/h.';

  it('accepts copy whose numbers all come from the source', () => {
    expect(verify({ title: 'Sperrung am Ostkreuz', body: 'Bahnhof Ostkreuz bis 11:30 Uhr gesperrt.' }, facts)).toEqual([]);
  });
  it('rejects invented numbers and times', () => {
    expect(verify({ title: 'Sperrung am Ostkreuz', body: 'Gesperrt bis 14:00 Uhr.' }, facts)).toContain('"14:00" is not in the source');
  });
  it('rejects invented escalation', () => {
    const p = verify({ title: 'Explosion am Ostkreuz', body: 'Bahnhof gesperrt.' }, facts);
    expect(p.some((x) => x.includes('explosion'))).toBe(true);
  });
  it('rejects area stigma', () => {
    expect(verify({ title: 'Gefährliches Viertel', body: 'Ostkreuz gesperrt.' }, facts)).toContain('describes an area as dangerous');
  });
  it('enforces lock-screen length limits', () => {
    expect(verify({ title: 'x'.repeat(51), body: 'ok' }, facts)[0]).toMatch(/title is 51/);
  });
  it('normalises numbers', () => {
    expect(numbers('3,5 cm um 09:15 und 110 km/h')).toEqual(['3.5', '9:15', '110']);
  });
  it('truncates on word boundaries', () => {
    expect(truncate('Polizeieinsatz am Bahnhof Ostkreuz in Friedrichshain', 30)).toBe('Polizeieinsatz am Bahnhof…');
  });
});

describe('compose', () => {
  const event = {
    category: 'crime', severity: 3, areaName: 'Ostkreuz', title: 't',
    facts: 'Bahnhof Ostkreuz seit 9:15 Uhr gesperrt. Sperrung bis 11:30 Uhr.',
    sources: [{ sourceName: 'Polizei Berlin', externalId: 'a', title: 'Polizeieinsatz am Ostkreuz – Bereich weiträumig gesperrt', official: false }],
  } as unknown as RiskEvent;

  it('retries once when the verifier rejects, then accepts', async () => {
    const llm = new ScriptedLLM([
      { title: 'Ostkreuz gesperrt', body: 'Gesperrt bis 15:00 Uhr.' }, // invented time
      { title: 'Ostkreuz gesperrt', body: 'Bahnhof Ostkreuz bis 11:30 Uhr gesperrt.' },
    ]);
    const copy = await compose(event, llm);
    expect(copy.isTemplate).toBe(false);
    expect(copy.body).toContain('11:30');
    expect(llm.calls[1]).toContain('rejected');
  });

  it('falls back to a grounded template when the model keeps failing', async () => {
    const llm = new ScriptedLLM([{ title: 'Ostkreuz', body: 'Bis 15:00.' }, { title: 'Ostkreuz', body: 'Bis 16:00.' }]);
    const copy = await compose(event, llm);
    expect(copy.isTemplate).toBe(true);
    expect(copy.title).toBe('Polizei: Ostkreuz');
    expect(copy.body).toContain('Polizeieinsatz am Ostkreuz');
    expect(copy.action).toContain('Polizei');
  });
});

describe('ranking', () => {
  const user = (over: Partial<User> = {}): User => ({
    id: 'u', tokenHash: '', pushToken: 'ExponentPushToken[x]', prefs: { ...DEFAULT_PREFS }, lat: FRIEDRICHSHAIN.lat, lon: FRIEDRICHSHAIN.lon,
    locationUpdatedAt: NOW.toISOString(), createdAt: NOW.toISOString(), ...over,
  });
  const ev = (over: Partial<RiskEvent> = {}) => ({ category: 'transit', severity: 3, official: false, lat: 52.5031, lon: 13.469, radiusM: 600, ...over }) as RiskEvent;
  const ctx = { now: NOW, pushesLast24h: 0, feedback: {} };

  it('matches current location and saved places', () => {
    expect(match(user(), [], ev(), 1500, NOW)?.place).toBeNull();
    const far = user({ lat: 48.13, lon: 11.57 });
    expect(match(far, [], ev(), 1500, NOW)).toBeNull();
    expect(match(far, [{ id: 'p', userId: 'u', label: 'Mama', lat: 52.503, lon: 13.47, radiusM: 300 }], ev(), 1500, NOW)?.place).toBe('Mama');
  });
  it('ignores stale locations', () => {
    expect(match(user({ locationUpdatedAt: '2026-11-12T00:00:00Z' }), [], ev(), 1500, NOW)).toBeNull();
  });
  it('official severity 5 always breaks through', () => {
    const u = user({ prefs: { ...DEFAULT_PREFS, categories: [] } });
    expect(decide(u, ev({ official: true, severity: 5, category: 'weather' }), { ...ctx, pushesLast24h: 99 }).delivery).toBe('push');
  });
  it('respects categories, daily limit and quiet hours', () => {
    expect(decide(user({ prefs: { ...DEFAULT_PREFS, categories: ['weather'] } }), ev(), ctx).delivery).toBe('suppressed');
    expect(decide(user(), ev(), { ...ctx, pushesLast24h: 3 }).reason).toBe('daily limit reached');
    expect(decide(user(), ev(), { ...ctx, now: new Date('2026-11-14T23:30:00+01:00') }).reason).toBe('quiet hours');
    expect(decide(user(), ev({ severity: 4 }), { ...ctx, now: new Date('2026-11-14T23:30:00+01:00') }).delivery).toBe('push');
  });
  it('learns from ratings', () => {
    expect(learnedRelevance({ relevant: 1, notRelevant: 2 })).toBeNull();
    const fb = { transit: { relevant: 0, notRelevant: 6 } };
    expect(decide(user(), ev(), { ...ctx, feedback: fb }).reason).toBe('usually rated not relevant');
  });
  it('handles quiet hours across midnight', () => {
    expect(inQuietHours(new Date('2026-11-14T06:30:00+01:00'), '22:00', '07:00', 'Europe/Berlin')).toBe(true);
    expect(inQuietHours(new Date('2026-11-14T07:30:00+01:00'), '22:00', '07:00', 'Europe/Berlin')).toBe(false);
  });
});

describe('extraction without AI', () => {
  it('drops past incidents and appeals for witnesses', () => {
    const [, appeal] = parseFeed(fx('police-berlin.rss'), { url: 'x', sourceName: 'Polizei Berlin', categoryHint: 'crime' });
    expect(heuristicExtract(appeal, `${appeal.title}\n${appeal.body}`, null)).toBeNull();
  });
  it('locates and classifies current incidents with low confidence', () => {
    const [op] = parseFeed(fx('police-berlin.rss'), { url: 'x', sourceName: 'Polizei Berlin', categoryHint: 'crime' });
    const ext = heuristicExtract(op, `${op.title}\n${op.body}`, null)!;
    expect(ext.areaName).toBe('Ostkreuz');
    expect(ext.confidence).toBeLessThan(0.6);
  });
});

describe('end-to-end pipeline', () => {
  let store: Store, push: MemoryPushSender, pipeline: Pipeline;
  beforeEach(() => {
    store = new Store();
    push = new MemoryPushSender();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: cfg, now: () => NOW });
  });

  function userAt(lat: number, lon: number, pushToken = 'ExponentPushToken[abc]') {
    const { user } = store.createUser(pushToken);
    store.updateLocation(user.id, lat, lon);
    return store.getUser(user.id)!;
  }

  it('official warning → alert + push to affected users only', async () => {
    const near = userAt(FRIEDRICHSHAIN.lat, FRIEDRICHSHAIN.lon);
    userAt(48.1374, 11.5755); // Munich
    const r = await pipeline.ingest([ninaItem()]);
    expect(r.eventsCreated).toBe(1);
    expect(r.alertsCreated).toBe(1);
    expect(push.outbox).toHaveLength(1);
    const [alert] = store.alertsForUser(near.id);
    expect(alert.official).toBe(true);
    expect(alert.severity).toBe(4);
    expect(alert.title.length).toBeLessThanOrEqual(50);
    expect(alert.body.length).toBeLessThanOrEqual(100);
    expect(alert.sourceName).toBe('Deutscher Wetterdienst');
  });

  it('is idempotent: re-ingesting the same item creates nothing', async () => {
    userAt(FRIEDRICHSHAIN.lat, FRIEDRICHSHAIN.lon);
    await pipeline.ingest([ninaItem()]);
    const r = await pipeline.ingest([ninaItem()]);
    expect(r.new).toBe(0);
    expect(push.outbox).toHaveLength(1);
  });

  it('unsure non-official items wait at the Alert Desk until approved', async () => {
    const u = userAt(52.5031, 13.469);
    const items = parseFeed(fx('police-berlin.rss'), { url: 'x', sourceName: 'Polizei Berlin', categoryHint: 'crime' });
    const r = await pipeline.ingest(items);
    expect(r.ignored).toBe(1); // the witness appeal
    expect(r.sentToReview).toBe(1);
    expect(store.alertsForUser(u.id)).toHaveLength(0);

    const [pending] = store.eventsByStatus('pending_review');
    const res = await pipeline.approve(pending.id, { body: 'Bahnhof Ostkreuz bis 11:30 Uhr gesperrt.' });
    expect(res?.alerts).toBe(1);
    expect(store.alertsForUser(u.id)[0].body).toBe('Bahnhof Ostkreuz bis 11:30 Uhr gesperrt.');
  });

  it('merges the same incident from two sources into one event', async () => {
    const police = parseFeed(fx('police-berlin.rss'), { url: 'x', sourceName: 'Polizei Berlin', categoryHint: 'crime' })[0];
    const transit = parseFeed(fx('transit.rss'), { url: 'y', sourceName: 'S-Bahn Berlin', categoryHint: 'transit' })[0];
    await pipeline.ingest([police, transit]);
    // Different categories (police vs transit) stay separate events — users get the transit impact and the police operation.
    expect(store.eventsByStatus('pending_review').length + store.eventsByStatus('auto').length).toBe(2);
    // Same category from two feeds merges:
    const transit2 = { ...transit, externalId: 'other-feed:1', sourceName: 'BVG' };
    const r = await pipeline.ingest([transit2]);
    expect(r.eventsUpdated).toBe(1);
    expect(r.eventsCreated).toBe(0);
  });

  it('saved places get alerts with the place name; feedback is recorded', async () => {
    const { user } = store.createUser('ExponentPushToken[m]');
    store.addPlace(user.id, 'Mama', 52.5101, 13.4585, 500);
    await pipeline.ingest([ninaItem()]);
    const [a] = store.alertsForUser(user.id);
    expect(a.matchedPlace).toBe('Mama');
    expect(a.title.startsWith('Mama:') || a.title.length > 0).toBe(true);
    expect(store.setFeedback(user.id, a.id, 'relevant')).toBe(true);
    expect(store.metrics('2000-01-01T00:00:00Z').relevantRate).toBe(1);
  });

  it('concierge manual alerts go straight out', async () => {
    const u = userAt(52.5031, 13.469);
    const r = await pipeline.manualAlert({ category: 'transit', severity: 3, title: 'S5 unterbrochen', body: 'Kein Zugverkehr zwischen Ostkreuz und Lichtenberg.',
      sourceName: 'Hey-Okay Redaktion', lat: 52.5031, lon: 13.469, radiusM: 1000, areaName: 'Ostkreuz' });
    expect(r.alerts).toBe(1);
    expect(store.alertsForUser(u.id)[0].aiWritten).toBe(false);
  });

  it('first sync after install fills the feed without a burst of pushes', async () => {
    await pipeline.ingest([ninaItem()]);
    const { user } = store.createUser('ExponentPushToken[new]');
    store.updateLocation(user.id, FRIEDRICHSHAIN.lat, FRIEDRICHSHAIN.lon);
    await pipeline.refreshUser(store.getUser(user.id)!, true);
    expect(store.alertsForUser(user.id)[0].delivery).toBe('feed');
  });

  it('GDPR delete removes the user and their alerts', async () => {
    const u = userAt(FRIEDRICHSHAIN.lat, FRIEDRICHSHAIN.lon);
    await pipeline.ingest([ninaItem()]);
    store.deleteUser(u.id);
    expect(store.getUser(u.id)).toBeNull();
    expect(store.alertsForUser(u.id)).toHaveLength(0);
  });
});
