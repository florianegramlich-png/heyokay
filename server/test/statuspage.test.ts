import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchStatusPage, incidentIoIncidents, incidentItem, parseStatusPages, US_STATUS_PAGES, type StatusPage, type StatuspageIncident } from '../src/sources/statuspage.js';
import { describeSource } from '../src/sources/registry.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { normalizePrefs } from '../src/types.js';
import { buildApi } from '../src/api.js';
import { SqliteStore } from '../src/db.js';
import { decide } from '../src/pipeline/rank.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/statuspage-unresolved.json', import.meta.url), 'utf8')) as { incidents: StatuspageIncident[] };
const INCIDENTIO = JSON.parse(readFileSync(new URL('./fixtures/incidentio-square-summary.json', import.meta.url), 'utf8'));
// The Statuspage fixture comes from Square's old page (Statuspage API until 2026-10); its tests keep that setup.
const SQUARE: StatusPage = { key: 'square', name: 'Square', url: 'https://www.issquareup.com', country: 'US', kind: 'payments' };
const NOW = new Date('2026-11-18T19:45:00Z');
const MARINA = { lat: 36.684, lon: -121.801 };
const HONOLULU = { lat: 21.307, lon: -157.858 };
const BERLIN = { lat: 52.52, lon: 13.405 };
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
const fixtureGet = (incidents = FIXTURE.incidents) => async () => ({ incidents });

describe('status pages → technology outages', () => {
  it('maps only major and critical incidents; critical may push, major is feed only', () => {
    const [critical, minor, major] = FIXTURE.incidents;
    const c = incidentItem(SQUARE, critical, NOW)!;
    expect(c).toMatchObject({ category: 'technology', hazard: 'outage', officialSeverity: 3, country: 'US', language: 'en', structured: true, official: false });
    expect(c.title).toBe('Square outage: service largely down');
    expect(c.body).toContain('Square reports: Card payments failing for some sellers.');
    expect(c.body).toContain('Affected: Card Payments, Point of Sale.');
    expect(c.body).toContain('Cash and manual entry still work.'); // latest update, provider's own words
    expect(c.references).toEqual(['statuspage:square:p9x2kq7rlm3c:1']);
    expect(incidentItem(SQUARE, minor, NOW)).toBeNull();
    expect(incidentItem(SQUARE, major, NOW)).toMatchObject({ officialSeverity: 1, title: 'Square outage: service disrupted' });
    expect(incidentItem(SQUARE, { ...critical, status: 'resolved' }, NOW)).toBeNull();
  });

  it('polls the public Statuspage API and lists every open incident for the all-clear check', async () => {
    const urls: string[] = [];
    const r = await fetchStatusPage(SQUARE, () => true, async (u) => { urls.push(u); return FIXTURE; }, NOW);
    expect(urls).toEqual(['https://www.issquareup.com/api/v2/incidents/unresolved.json']);
    expect(r.feedKey).toBe('statuspage:square');
    expect(r.items.map((i) => i.externalId)).toEqual(['statuspage:square:p9x2kq7rlm3c:3', 'statuspage:square:z9y8x7w6v5u4:1']);
    expect(r.listedIds.has('statuspage:square:p9x2kq7rlm3c:1')).toBe(true); // the lower level stays "listed" while critical
  });

  it('money and home services: their own words for what an outage affects; keys are unique', () => {
    const page = (key: string) => US_STATUS_PAGES.find((p) => p.key === key)!;
    const [critical] = FIXTURE.incidents;
    const bare = { ...critical, components: [] };
    expect(incidentItem(page('chime'), bare, NOW)!.body).toContain('This can affect banking, transfers and card payments.');
    expect(incidentItem(page('ring'), bare, NOW)!).toMatchObject({ service: 'ring', title: 'Ring outage: service largely down' });
    expect(incidentItem(page('ring'), bare, NOW)!.body).toContain('cameras and alarms reaching your phone');
    const keys = US_STATUS_PAGES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of US_STATUS_PAGES) expect(p.url).toMatch(/^https:\/\/[^/]+$/);
    expect(describeSource('statuspage:chime')).toMatchObject({ country: 'US', category: 'technology' });
  });

  it('incident.io pages (Square today, ChatGPT): the country sub-page only; full outage = critical, partial = major', async () => {
    const live = US_STATUS_PAGES.find((p) => p.key === 'square')!;
    expect(live).toMatchObject({ api: 'incidentio', subpage: 'united-states' });
    const urls: string[] = [];
    const r = await fetchStatusPage(live, () => true, async (u) => { urls.push(u); return INCIDENTIO; }, NOW);
    expect(urls).toEqual(['https://www.issquareup.com/api/v1/summary']);
    expect(r.items).toHaveLength(1); // degraded performance is not an alert; Canada is not read
    expect(r.items[0]).toMatchObject({
      externalId: 'statuspage:square:01KUS0000000000000000US001:3', service: 'square', officialSeverity: 3,
      title: 'Square outage: service largely down', url: 'https://www.issquareup.com/united-states/incidents/01KUS0000000000000000US001',
      publishedAt: '2026-11-20T18:05:00.000Z',
    });
    expect(r.items[0].body).toBe('Square reports: Card payments failing for some sellers. Affected: Card Payments, Point of Sale. We have identified the cause. Cash and manual entry still work.');
    const canada = incidentIoIncidents(INCIDENTIO, 'canada');
    expect(canada[0]).toMatchObject({ impact: 'major', status: 'identified' });
    // A single page (OpenAI) has the summary at the top level.
    const single = { page_title: 'OpenAI', ongoing_incidents: INCIDENTIO.subpages[1].summary.ongoing_incidents };
    expect(incidentIoIncidents(single).map((i) => i.impact)).toEqual(['critical', 'minor']);
    expect(incidentIoIncidents({ page_title: 'OpenAI', ongoing_incidents: [] })).toEqual([]);
    // A changed API fails the poll (shows as failing on the Alert Desk) instead of looking like "no outages".
    expect(() => incidentIoIncidents({ subpages: [] }, 'united-states')).toThrow(/ongoing_incidents/);
    expect(() => incidentIoIncidents({ page: null })).toThrow();
  });

  it('STATUS_PAGES: default US list, a custom list, or off; the registry describes them', () => {
    expect(parseStatusPages(undefined).map((p) => p.key)).toContain('square');
    expect(parseStatusPages('off')).toEqual([]);
    expect(parseStatusPages('[{"key":"x","name":"X","url":"https://status.x","country":"US","kind":"apps"}]')[0].name).toBe('X');
    expect(describeSource('statuspage:zoom')).toMatchObject({ country: 'US', category: 'technology', official: false });
  });

  it('existing people get the new category switched on once; after that their choice stands', () => {
    const old = normalizePrefs({ categories: ['weather', 'crime'] });
    expect(old.categories).toEqual(['weather', 'crime', 'technology']);
    expect(normalizePrefs({ ...old, categories: ['weather'] }).categories).toEqual(['weather']); // turned off later: stays off
  });
});

describe('only the services I use', () => {
  it('outages carry their service; ranking skips services the person did not pick; null = all', () => {
    const item = incidentItem(SQUARE, FIXTURE.incidents[0], NOW)!;
    expect(item.service).toBe('square');
    const base = { id: 'u', tokenHash: '', pushToken: null, lat: null, lon: null, locationUpdatedAt: null, createdAt: '' };
    const event = { category: 'technology', severity: 3, official: false, service: 'square' } as any;
    const ctx = { now: NOW, pushesLast24h: 0, feedback: {} };
    const user = (techServices?: string[] | null) => ({ ...base, prefs: { ...normalizePrefs({ quietHours: null }), techServices } });
    expect(decide(user(['zoom']), event, ctx)).toEqual({ delivery: 'suppressed', reason: 'service not followed' });
    expect(decide(user(['zoom', 'square']), event, ctx).delivery).toBe('push');
    expect(decide(user(null), event, ctx).delivery).toBe('push');
    expect(decide(user(undefined), event, ctx).delivery).toBe('push');
    expect(decide(user([]), event, ctx).delivery).toBe('suppressed'); // picked none = no outages
    // Older events without a service still reach everyone who follows the category.
    expect(decide(user(['zoom']), { ...event, service: undefined }, ctx).delivery).toBe('push');
  });

  it('API: GET /v1/services lists what can be followed; prefs accept a list or null and reject junk', async () => {
    const store = new SqliteStore();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg });
    const app = buildApi({ store, pipeline, adminToken: 'x', runIngest: async () => ({}) });
    const list = (await app.inject({ method: 'GET', url: '/v1/services' })).json();
    expect(list.services.map((x: any) => x.name)).toEqual(['Affirm', 'Cash App', 'ChatGPT', 'Chime', 'Cloudflare', 'Coinbase', 'Discord', 'Dropbox', 'Klarna', 'Reddit', 'Ring', 'Robinhood', 'Square', 'Wise', 'Zoom']);
    expect(list.services.find((x: any) => x.key === 'cloudflare')).toEqual({ key: 'cloudflare', name: 'Cloudflare', kind: 'internet', country: 'US' });
    expect(list.services.find((x: any) => x.key === 'square')).toEqual({ key: 'square', name: 'Square', kind: 'payments', country: 'US' }); // no API details
    const custom = buildApi({ store, pipeline, adminToken: 'x', runIngest: async () => ({}), statusPages: [] });
    expect((await custom.inject({ method: 'GET', url: '/v1/services' })).json()).toEqual({ services: [] });
    const reg = (await app.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json();
    expect(reg.prefs.techServices).toBeUndefined(); // default: every service
    const auth = { authorization: `Bearer ${reg.token}` };
    const pick = await app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: auth, payload: { techServices: ['zoom', 'square'] } });
    expect(pick.json().prefs.techServices).toEqual(['zoom', 'square']);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json().prefs.techServices).toEqual(['zoom', 'square']);
    expect((await app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: auth, payload: { techServices: null } })).json().prefs.techServices).toBeNull();
    expect((await app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: auth, payload: { techServices: ['Zoom!'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: auth, payload: { techServices: Array(101).fill('x') } })).statusCode).toBe(400);
    await app.close(); await custom.close(); await store.close();
  });
});

describe.each(storeBackends())('outages through the pipeline ($name)', (backend) => {
  let store: Store;
  let pipeline: Pipeline;
  let push: MemoryPushSender;
  beforeEach(async () => {
    store = await backend.make();
    push = new MemoryPushSender();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: cfg, now: () => NOW });
  });
  afterEach(async () => { await store.close(); });
  const userAt = async (p: { lat: number; lon: number }, token: string, prefs: object = { timezone: 'America/Los_Angeles', language: 'en', quietHours: null }) => {
    const { user } = await store.createUser(token, prefs as any);
    await store.updateLocation(user.id, p.lat, p.lon);
    return user;
  };

  it('everyone in the US gets the critical outage (push) and the major one (feed); nobody in Berlin; resolved → all clear', async () => {
    const marina = await userAt(MARINA, 'ExponentPushToken[marina]');
    const honolulu = await userAt(HONOLULU, 'ExponentPushToken[hnl]');
    const berlin = await userAt(BERLIN, 'ExponentPushToken[ber]', { language: 'de' });

    const poll = await fetchStatusPage(SQUARE, () => true, fixtureGet(), NOW);
    const r = await pipeline.ingest(poll.items);
    expect(r.eventsCreated).toBe(2);
    expect(r.sentToReview).toBe(0);

    const alerts = await store.alertsForUser(marina.id);
    const critical = alerts.find((a) => a.severity === 3)!;
    expect(critical).toMatchObject({ category: 'technology', delivery: 'push', title: 'Square outage: service largely down' });
    expect(critical.action).toBe("Have a backup ready, such as cash or another app. Check the provider's status page.");
    expect(alerts.find((a) => a.severity === 1)?.delivery).toBe('feed');
    expect((await store.alertsForUser(honolulu.id)).length).toBe(2);
    expect(await store.alertsForUser(berlin.id)).toHaveLength(0);
    expect(push.outbox.map((m) => m.token).sort()).toEqual(['ExponentPushToken[hnl]', 'ExponentPushToken[marina]']);

    // Next poll: the critical incident is resolved (gone from the list), the major one remains.
    const next = await fetchStatusPage(SQUARE, () => false, fixtureGet([FIXTURE.incidents[2]]), NOW);
    const rec = await pipeline.reconcileFeed(next.feedKey, next.listedIds);
    expect(rec.ended).toBe(1);
    const after = await store.alertsForUser(marina.id);
    expect(after.some((a) => a.kind === 'all_clear' && a.title.startsWith('All clear: Square outage'))).toBe(true);
  });

  it('people who switched technology off get nothing', async () => {
    const off = await userAt(MARINA, 'ExponentPushToken[off]', { timezone: 'America/Los_Angeles', language: 'en', categories: ['weather'], knownCategories: ['weather', 'crime', 'transit', 'public_safety', 'health', 'infrastructure', 'technology'] });
    await pipeline.ingest((await fetchStatusPage(SQUARE, () => true, fixtureGet(), NOW)).items);
    expect(await store.alertsForUser(off.id)).toHaveLength(0);
  });

  it('only the services I use: a Zoom-only person gets no Square outage, a Square follower does', async () => {
    const tz = { timezone: 'America/Los_Angeles', language: 'en', quietHours: null };
    const zoomOnly = await userAt(MARINA, 'ExponentPushToken[zoom]', { ...tz, techServices: ['zoom'] });
    const square = await userAt(HONOLULU, 'ExponentPushToken[sq]', { ...tz, techServices: ['square'] });
    const all = await userAt(MARINA, 'ExponentPushToken[all]', { ...tz, techServices: null });
    await pipeline.ingest((await fetchStatusPage(SQUARE, () => true, fixtureGet(), NOW)).items);
    expect(await store.alertsForUser(zoomOnly.id)).toHaveLength(0);
    expect((await store.alertsForUser(square.id)).find((a) => a.severity === 3)?.delivery).toBe('push');
    expect(await store.alertsForUser(all.id)).toHaveLength(2);
    expect(push.outbox.map((m) => m.token).sort()).toEqual(['ExponentPushToken[all]', 'ExponentPushToken[sq]']);
    expect((await store.getEvent((await store.alertsForUser(square.id))[0].eventId))?.service).toBe('square');
  });
});
