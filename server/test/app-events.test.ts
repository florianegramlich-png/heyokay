import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { APP_EVENTS, funnelReport, type AppEventCount } from '../src/app-events.js';
import { DESK_HTML } from '../src/desk.js';

// PRD 13, product analytics part 2: anonymous app events and the onboarding funnel.

describe('funnelReport', () => {
  it('funnels for the phone app, each platform and the web (no notification step); permission rates', () => {
    const rows: AppEventCount[] = [
      { day: '2026-11-24', platform: 'ios', name: 'onb_value', count: 10 },
      { day: '2026-11-24', platform: 'android', name: 'onb_value', count: 10 },
      { day: '2026-11-24', platform: 'ios', name: 'onb_location', count: 8 },
      { day: '2026-11-24', platform: 'android', name: 'onb_location', count: 8 },
      { day: '2026-11-24', platform: 'ios', name: 'onb_notifications', count: 8 },
      { day: '2026-11-24', platform: 'ios', name: 'onb_done', count: 4 },
      { day: '2026-11-24', platform: 'web', name: 'onb_value', count: 5 },
      { day: '2026-11-24', platform: 'web', name: 'onb_location', count: 5 },
      { day: '2026-11-24', platform: 'ios', name: 'perm_push_granted', count: 6 },
      { day: '2026-11-24', platform: 'ios', name: 'perm_push_denied', count: 1 },
      { day: '2026-11-24', platform: 'ios', name: 'perm_push_later', count: 1 },
      { day: '2026-11-24', platform: 'android', name: 'push_turned_off', count: 2 },
    ];
    const r = funnelReport(rows);
    const app = r.funnels.find((f) => f.platform === 'app')!;
    expect(app.steps.map((s) => s.step)).toEqual(['onb_value', 'onb_location', 'onb_notifications', 'onb_categories', 'onb_consent', 'onb_done']);
    expect(app.steps[0]).toMatchObject({ count: 20, ofPrevious: null, ofStart: null });
    expect(app.steps[1]).toMatchObject({ count: 16, ofPrevious: 0.8, ofStart: 0.8 });
    expect(app.steps[2]).toMatchObject({ count: 8, ofPrevious: 0.5 });
    expect(app.steps[3]).toMatchObject({ count: 0, ofPrevious: 0 });
    expect(app.steps[4]).toMatchObject({ count: 0, ofPrevious: null }); // nothing to compare with
    const web = r.funnels.find((f) => f.platform === 'web')!;
    expect(web.steps.map((s) => s.step)).not.toContain('onb_notifications');
    expect(web.steps[1]).toMatchObject({ count: 5, ofPrevious: 1 });
    expect(r.permissions.find((p) => p.key === 'push')).toMatchObject({ granted: 6, denied: 1, later: 1, grantedRate: 0.75 });
    expect(r.permissions.find((p) => p.key === 'location')!.grantedRate).toBeNull();
    expect(r).toMatchObject({ pushTurnedOff: 2, pushTurnedOn: 0, total: 68 });
  });

  it('the phone app and the web send exactly the names the server accepts', async () => {
    const names = (src: string) => [...src.slice(src.indexOf('APP_EVENTS = ['), src.indexOf('] as const')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const file of ['../../app/src/lib/analytics.ts', '../../web/lib/analytics.ts']) {
      const src = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(names(src), file).toEqual([...APP_EVENTS]);
    }
  });
});

describe.each(storeBackends())('app events ($name)', (backend) => {
  let store: Store, clock: Date;
  beforeEach(async () => { store = await backend.make(); clock = new Date('2026-11-24T08:00:00Z'); });
  afterEach(async () => { await store.close(); });

  const api = () => {
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(),
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 }, now: () => clock });
    return buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock });
  };

  it('store: counts add up per day, platform and name', async () => {
    await store.addAppEvents('2026-11-23', 'ios', new Map([['onb_value', 2], ['onb_done', 1]]));
    await store.addAppEvents('2026-11-24', 'ios', new Map([['onb_value', 1]]));
    await store.addAppEvents('2026-11-24', 'ios', new Map([['onb_value', 3]]));
    await store.addAppEvents('2026-11-24', 'web', new Map([['onb_value', 1]]));
    await store.addAppEvents('2026-11-24', 'web', new Map());
    expect(await store.appEventCounts('2026-11-24')).toEqual([
      { day: '2026-11-24', platform: 'ios', name: 'onb_value', count: 4 },
      { day: '2026-11-24', platform: 'web', name: 'onb_value', count: 1 },
    ]);
    expect(await store.appEventCounts('2026-11-01')).toHaveLength(4);
  });

  it('POST /v1/events: no token needed, nothing identifying kept; funnel on the desk', async () => {
    const app = api();
    const post = (payload: object, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/v1/events', payload, headers });
    expect((await post({ platform: 'ios', events: [{ name: 'onb_value' }, { name: 'onb_location' }, { name: 'perm_location_granted' }] })).statusCode).toBe(200);
    // A registered device may send too; the token is ignored.
    const reg = (await app.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json();
    expect((await post({ platform: 'ios', events: [{ name: 'onb_value' }] }, { authorization: `Bearer ${reg.token}` })).statusCode).toBe(200);
    clock = new Date('2026-11-25T08:00:00Z');
    expect((await post({ platform: 'web', events: [{ name: 'onb_value' }] })).statusCode).toBe(200);

    const rows = await store.appEventCounts('2026-01-01');
    expect(rows).toContainEqual({ day: '2026-11-24', platform: 'ios', name: 'onb_value', count: 2 });
    expect(rows).toContainEqual({ day: '2026-11-25', platform: 'web', name: 'onb_value', count: 1 });
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${reg.userId}|127\\.0\\.0\\.1|T08`));

    expect((await app.inject({ method: 'GET', url: '/admin/api/funnel' })).statusCode).toBe(401);
    const f = (await app.inject({ method: 'GET', url: '/admin/api/funnel?days=7', headers: { 'x-admin-token': 'secret' } })).json();
    expect(f.since).toBe('2026-11-19');
    expect(f.funnels[0].steps[0]).toMatchObject({ step: 'onb_value', count: 2 });
    expect(f.funnels.find((x: { platform: string }) => x.platform === 'web').steps[0].count).toBe(1);
    expect(f.permissions[0]).toMatchObject({ key: 'location', granted: 1, grantedRate: 1 });
    const today = (await app.inject({ method: 'GET', url: '/admin/api/funnel?days=1', headers: { 'x-admin-token': 'secret' } })).json();
    expect(today.total).toBe(1);
    expect(DESK_HTML).toContain('/admin/api/funnel');
  });

  it('refuses unknown names, extra fields (no ids sneak in), empty or too large batches; limits each address', async () => {
    const app = api();
    const post = (payload: object) => app.inject({ method: 'POST', url: '/v1/events', payload });
    expect((await post({ platform: 'ios', events: [{ name: 'opened_settings' }] })).statusCode).toBe(400);
    expect((await post({ platform: 'ios', events: [{ name: 'onb_value', userId: 'u1' }] })).statusCode).toBe(400);
    expect((await post({ platform: 'ios', deviceId: 'd', events: [{ name: 'onb_value' }] })).statusCode).toBe(400);
    expect((await post({ platform: 'windows', events: [{ name: 'onb_value' }] })).statusCode).toBe(400);
    expect((await post({ platform: 'ios', events: [] })).statusCode).toBe(400);
    expect((await post({ platform: 'ios', events: Array(21).fill({ name: 'onb_value' }) })).statusCode).toBe(400);
    expect(await store.appEventCounts('2026-01-01')).toEqual([]);
    // 60 requests per address per 10 minutes (the 6 refused ones count too).
    const ok = { platform: 'android', events: [{ name: 'onb_value' }] };
    for (let i = 0; i < 54; i++) expect((await post(ok)).statusCode).toBe(200);
    expect((await post(ok)).statusCode).toBe(429);
    clock = new Date(clock.getTime() + 10 * 60_000 + 1);
    expect((await post(ok)).statusCode).toBe(200);
    expect((await store.appEventCounts('2026-01-01'))[0].count).toBe(55);
  });
});
