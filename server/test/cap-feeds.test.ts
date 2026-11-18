import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCap, capAlertsIn } from '../src/sources/cap.js';
import { fetchIpaws, ipawsItems, IPAWS_URL } from '../src/sources/ipaws.js';
import { fetchSachet, parseSachetRss } from '../src/sources/sachet.js';
import { COUNTRIES, packFor } from '../src/countries.js';
import { describeSource, parseCountries } from '../src/sources/registry.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const IPAWS = fx('ipaws-recent.xml');
const RSS = fx('sachet-rss.xml');
const CAP_BLR = fx('sachet-cap-bengaluru.xml');
const CAP_TN = fx('sachet-cap-tamilnadu.xml');
const NOW = new Date('2026-11-18T10:00:00Z');
const sachetGet = (rss = RSS) => async (url: string) => (url.endsWith('.xml') ? rss : url.endsWith('123456') ? CAP_BLR : CAP_TN);
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };

describe('CAP parser', () => {
  it('reads alerts, infos, polygons and circles; finds every alert in a feed', () => {
    expect(capAlertsIn(IPAWS)).toHaveLength(3);
    const a = parseCap(CAP_BLR)!;
    expect(a).toMatchObject({ identifier: '1763480000123456', status: 'Actual', msgType: 'Alert', scope: 'Public' });
    expect(a.infos.map((i) => i.language)).toEqual(['hi-IN', 'en-IN']);
    expect(a.infos[1].areas[0].rings[0]).toHaveLength(5);
    const circle = parseCap(CAP_TN)!.infos[0].areas[0].rings[0];
    expect(circle.length).toBe(25); // 24-point circle, closed
  });
});

describe('FEMA IPAWS (US)', () => {
  it('maps local official alerts; skips NWS (own adapter) and tests', () => {
    const items = ipawsItems(IPAWS, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'ipaws', official: true, country: 'US', language: 'en', category: 'public_safety', officialSeverity: 4,
      sourceName: 'Monterey County Office of Emergency Services', title: 'Evacuation Warning for Carmel Valley Road area',
    });
    expect(items[0].expiresAt).toBe('2026-11-19T14:00:00.000Z');
  });

  it('asks for the alerts of the last hours', async () => {
    const urls: string[] = [];
    await fetchIpaws(() => true, async (u) => { urls.push(u); return IPAWS; }, { now: NOW });
    expect(urls).toEqual([`${IPAWS_URL}2026-11-18T04:00:00Z`]);
  });
});

describe('NDMA SACHET (India)', () => {
  it('country pack India: English, 112, police 100; COUNTRIES accepts IN', () => {
    expect(COUNTRIES.IN).toMatchObject({ language: 'en', numbers: { emergency: '112', police: '100' } });
    expect(packFor({ country: 'IN' }).code).toBe('IN');
    expect(parseCountries('DE,US,IN')).toEqual(['DE', 'US', 'IN']);
    expect(describeSource('sachet:IN')).toMatchObject({ country: 'IN', official: true });
  });

  it('reads the RSS, fetches each CAP file once, prefers the English info block', async () => {
    expect(parseSachetRss(RSS)).toHaveLength(2);
    const fetched: string[] = [];
    const r = await fetchSachet(() => true, async (u) => { fetched.push(u); return sachetGet()(u); }, { now: NOW });
    expect(fetched).toHaveLength(3); // RSS + two CAP files
    const blr = r.items.find((i) => i.externalId === '1763480000123456')!;
    expect(blr).toMatchObject({ title: 'Heavy rainfall warning for Bengaluru Urban', language: 'en', country: 'IN', category: 'weather', officialSeverity: 4, sourceName: 'India Meteorological Department' });
    // Known alerts are not downloaded again.
    fetched.length = 0;
    const again = await fetchSachet((id) => id !== '1763480000123456', async (u) => { fetched.push(u); return sachetGet()(u); }, { now: NOW });
    expect(fetched.some((u) => u.endsWith('123456'))).toBe(false);
    expect(again.listedIds.has('1763480000123456')).toBe(true);
  });
});

describe.each(storeBackends())('official CAP alerts through the pipeline ($name)', (backend) => {
  let store: Store;
  let pipeline: Pipeline;
  beforeEach(async () => {
    store = await backend.make();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => NOW });
  });
  afterEach(async () => { await store.close(); });
  const userAt = async (lat: number, lon: number, prefs: object) => {
    const { user } = await store.createUser('ExponentPushToken[x]', { language: 'en', quietHours: null, ...prefs } as any);
    await store.updateLocation(user.id, lat, lon);
    return user;
  };

  it('India: Bengaluru gets the IMD warning in English with 112; Chennai gets the wave alert; withdrawn → all clear', async () => {
    const blr = await userAt(12.97, 77.59, { timezone: 'Asia/Kolkata' });
    const chennai = await userAt(13.08, 80.27, { timezone: 'Asia/Kolkata' });
    const poll = await fetchSachet(() => true, sachetGet(), { now: NOW });
    const r = await pipeline.ingest(poll.items);
    expect(r.eventsCreated).toBe(2);
    expect(r.sentToReview).toBe(0);
    const [a] = await store.alertsForUser(blr.id);
    expect(a).toMatchObject({ category: 'weather', severity: 4, official: true, delivery: 'push' });
    expect(a.title).toContain('Bengaluru');
    expect((await store.alertsForUser(chennai.id)).map((x) => x.title)).toEqual([expect.stringContaining('Chennai')]);

    const withdrawn = RSS.replace(/<item>\s*<title>High wave[\s\S]*?<\/item>/, '');
    const next = await fetchSachet(() => false, sachetGet(withdrawn), { now: NOW });
    expect((await pipeline.reconcileFeed(next.feedKey, next.listedIds)).ended).toBe(1);
    expect((await store.alertsForUser(chennai.id)).some((x) => x.kind === 'all_clear')).toBe(true);
  });

  it('US: an evacuation warning reaches people in Carmel Valley, not in Marina', async () => {
    const carmel = await userAt(36.48, -121.75, { timezone: 'America/Los_Angeles' });
    const marina = await userAt(36.684, -121.801, { timezone: 'America/Los_Angeles' });
    await pipeline.ingest(ipawsItems(IPAWS, NOW));
    const [a] = await store.alertsForUser(carmel.id);
    expect(a).toMatchObject({ category: 'public_safety', severity: 4, official: true });
    expect(await store.alertsForUser(marina.id)).toHaveLength(0);
  });
});
