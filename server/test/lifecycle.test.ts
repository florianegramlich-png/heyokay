import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/db.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import type { SourceItem } from '../src/types.js';

// PRD 5.4: when an event escalates, changes or is lifted, people who got it are told.
// Updates and all-clears never count toward the daily limit.

const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
const HOME = { lat: 37.61, lon: -122.49 };
const FAR = { lat: 38.58, lon: -121.49 };
let clock = new Date('2026-11-17T12:00:00-08:00'); // midday in California: no quiet hours

const ring: [number, number][] = [[-122.6, 37.5], [-122.3, 37.5], [-122.3, 37.8], [-122.6, 37.8], [-122.6, 37.5]];
const hours = (h: number) => new Date(clock.getTime() + h * 3600_000).toISOString();

function nws(id: string, o: Partial<SourceItem> = {}): SourceItem {
  return {
    source: 'nws', sourceName: 'NWS San Francisco CA', externalId: id, official: true, language: 'en',
    title: 'Wind Advisory until November 18 at 1:00PM PST', body: 'WHAT...Gusts up to 45 mph.',
    publishedAt: clock.toISOString(), lat: 37.65, lon: -122.45, radiusM: 20_000, areas: [ring],
    officialSeverity: 3, category: 'weather', expiresAt: hours(12), areaName: 'San Francisco; Coastal North Bay',
    feedKey: 'nws:CA', ...o,
  };
}

describe('event lifecycle: updates and all-clears', () => {
  let store: Store, push: MemoryPushSender, pipeline: Pipeline;
  const user = (p: { lat: number; lon: number }, prefs = {}) => {
    const { user } = store.createUser('ExponentPushToken[t]', { timezone: 'America/Los_Angeles', language: 'en', ...prefs });
    store.updateLocation(user.id, p.lat, p.lon);
    return user;
  };
  const kinds = (userId: string) => store.alertsForUser(userId).map((a) => a.kind);

  beforeEach(() => {
    clock = new Date('2026-11-17T12:00:00-08:00');
    store = new Store();
    push = new MemoryPushSender();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: cfg, now: () => clock });
  });

  it('a cancellation sends an all-clear push to people who got a push, and nothing to others', async () => {
    const home = user(HOME);
    const far = user(FAR);
    await pipeline.ingest([nws('a1')]);
    expect(push.outbox).toHaveLength(1);

    clock = new Date(clock.getTime() + 3600_000);
    const r = await pipeline.ingest([nws('a2', { references: ['a1'], expiresAt: clock.toISOString() })]);
    expect(r.allClears).toBe(1);
    expect(r.eventsCreated).toBe(0);
    const [latest] = store.alertsForUser(home.id);
    expect(latest.kind).toBe('all_clear');
    expect(latest.title).toBe('All clear: Weather: Wind Advisory');
    expect(latest.body).toBe('The warning has been lifted.');
    expect(latest.delivery).toBe('push');
    expect(push.outbox).toHaveLength(2);
    expect(store.alertsForUser(far.id)).toHaveLength(0);
  });

  it('all-clears do not count toward the daily limit, and respect quiet hours', async () => {
    const home = user(HOME, { dailyLimit: 1 });
    await pipeline.ingest([nws('a1')]);
    await pipeline.endEvent(store.alertsForUser(home.id)[0].eventId);
    expect(store.pushCountSince(home.id, '2000-01-01T00:00:00Z')).toBe(1); // only the original

    clock = new Date('2026-11-17T23:30:00-08:00'); // quiet hours 22–7
    await pipeline.ingest([nws('b1', { title: 'Dense Fog Advisory until November 18 at 9:00AM PST', expiresAt: hours(6) })]);
    const fog = store.alertsForUser(home.id).find((a) => a.title.includes('Fog'))!;
    const pushesBefore = push.outbox.length;
    await pipeline.endEvent(fog.eventId);
    const clear = store.alertsForUser(home.id)[0];
    expect(clear.kind).toBe('all_clear');
    expect(clear.delivery).toBe('feed');
    expect(push.outbox.length).toBe(pushesBefore);
  });

  it('a downgrade or a moved end time is a calm feed update for people who already have it', async () => {
    const home = user(HOME);
    await pipeline.ingest([nws('a1', { officialSeverity: 4 })]);
    const pushes = push.outbox.length;

    const r = await pipeline.ingest([nws('a2', { references: ['a1'], officialSeverity: 3 })]);
    expect(r.updates).toBe(1);
    const [u] = store.alertsForUser(home.id);
    expect(u.kind).toBe('update');
    expect(u.title.startsWith('Update: ')).toBe(true);
    expect(u.delivery).toBe('feed');
    expect(push.outbox.length).toBe(pushes);

    // Small end-time shift (< 1 h): not worth an update.
    const r2 = await pipeline.ingest([nws('a3', { references: ['a2'], officialSeverity: 3, expiresAt: hours(12.5) })]);
    expect(r2.updates).toBe(0);
    // Extended by 6 hours: update, using the newest headline.
    const r3 = await pipeline.ingest([nws('a4', { references: ['a3'], officialSeverity: 3, expiresAt: hours(18), title: 'Wind Advisory until November 18 at 7:00PM PST' })]);
    expect(r3.updates).toBe(1);
    expect(store.alertsForUser(home.id)[0].body).toBe('Wind Advisory until November 18 at 7:00PM PST');
    expect(kinds(home.id)).toEqual(['update', 'update', 'new']);
  });

  it('an escalation is a new alert with a push, as before', async () => {
    const home = user(HOME);
    await pipeline.ingest([nws('a1')]);
    const r = await pipeline.ingest([nws('a2', { references: ['a1'], officialSeverity: 4 })]);
    expect(r.alertsCreated).toBe(1);
    expect(kinds(home.id)).toEqual(['new', 'new']);
    expect(push.outbox).toHaveLength(2);
  });

  it('an update to a warning that started days ago still finds its event', async () => {
    const home = user(HOME);
    await pipeline.ingest([nws('a1', { expiresAt: hours(96) })]);
    clock = new Date(clock.getTime() + 50 * 3600_000); // older than the 24 h clustering window
    const r = await pipeline.ingest([nws('a2', { references: ['a1'], expiresAt: hours(1) })]);
    expect(r.eventsCreated).toBe(0);
    expect(r.updates).toBe(1); // end moved 45 h earlier
    expect(kinds(home.id)).toEqual(['update', 'new']);
  });

  it('an alert that vanishes from its feed early is lifted; one that runs out on time ends quietly', async () => {
    const home = user(HOME);
    await pipeline.ingest([nws('a1', { expiresAt: hours(6) }), nws('b1', { title: 'Beach Hazards Statement until 12:10PM', expiresAt: hours(0.1), areas: [ring] })]);
    expect(store.alertsForUser(home.id)).toHaveLength(2);

    // Next poll: both gone from the feed. b1 was ending in 6 minutes anyway; a1 had 6 hours left.
    const out = await pipeline.reconcileFeed('nws:CA', new Set());
    expect(out.ended).toBe(1);
    const clears = store.alertsForUser(home.id).filter((a) => a.kind === 'all_clear');
    expect(clears).toHaveLength(1);
    expect(clears[0].title).toBe('All clear: Weather: Wind Advisory');

    // Still listed → untouched. Other feeds → untouched.
    await pipeline.ingest([nws('c1', { title: 'High Surf Advisory until November 19', expiresAt: hours(30) })]);
    expect((await pipeline.reconcileFeed('nws:CA', new Set(['c1']))).ended).toBe(0);
    expect((await pipeline.reconcileFeed('nws:NV', new Set())).ended).toBe(0);
  });

  it('German events get German all-clears', async () => {
    const { user: u } = store.createUser('ExponentPushToken[de]', { timezone: 'Europe/Berlin' });
    store.updateLocation(u.id, 52.5155, 13.4549);
    clock = new Date('2026-11-17T12:00:00+01:00');
    const r = await pipeline.manualAlert({
      category: 'transit', severity: 3, title: 'S-Bahn Ostkreuz gesperrt', body: 'Bis 14 Uhr kein Zugverkehr.',
      sourceName: 'Hey-Okay Redaktion', lat: 52.5155, lon: 13.4549, radiusM: 1500, areaName: 'Berlin-Friedrichshain',
    });
    await pipeline.endEvent(r.eventId);
    const [clear] = store.alertsForUser(u.id);
    expect(clear.title).toBe('Entwarnung: S-Bahn Ostkreuz gesperrt');
    expect(clear.body).toBe('Die Warnung ist aufgehoben.');
  });

  it('the feed API labels alert kinds and marks ended events; ending needs the admin token', async () => {
    const reg = store.createUser('ExponentPushToken[x]', { timezone: 'America/Los_Angeles' });
    store.updateLocation(reg.user.id, HOME.lat, HOME.lon);
    const app = buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}) });
    await pipeline.ingest([nws('a1'), nws('z1', { title: 'High Surf Advisory until November 19', expiresAt: hours(30) })]);
    const wind = store.alertsForUser(reg.user.id).find((a) => a.title.includes('Wind'))!;

    expect((await app.inject({ method: 'POST', url: `/admin/api/events/${wind.eventId}/end` })).statusCode).toBe(401);
    const ended = await app.inject({ method: 'POST', url: `/admin/api/events/${wind.eventId}/end`, headers: { 'x-admin-token': 'secret' } });
    expect(ended.json()).toMatchObject({ alerts: 1 });

    const res = await app.inject({ method: 'GET', url: '/v1/me/alerts', headers: { authorization: `Bearer ${reg.token}` } });
    const feed = res.json().alerts as Array<{ title: string; kind: string; ended: boolean }>;
    const byTitle = (t: string) => feed.filter((a) => a.title.includes(t)).map((a) => [a.kind, a.ended]);
    expect(byTitle('Wind')).toEqual([['all_clear', true], ['new', true]]);
    expect(byTitle('Surf')).toEqual([['new', false]]);
  });
});
