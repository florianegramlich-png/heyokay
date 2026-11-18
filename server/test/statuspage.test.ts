import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchStatusPage, incidentItem, parseStatusPages, US_STATUS_PAGES, type StatuspageIncident } from '../src/sources/statuspage.js';
import { describeSource } from '../src/sources/registry.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { normalizePrefs } from '../src/types.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/statuspage-unresolved.json', import.meta.url), 'utf8')) as { incidents: StatuspageIncident[] };
const SQUARE = US_STATUS_PAGES.find((p) => p.key === 'square')!;
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
});
