import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { hashPassword, readCookie, reviewTimes, verifyPassword } from '../src/desk-auth.js';
import type { SourceItem } from '../src/types.js';

// PRD 6.2 step 5: individual Alert Desk logins; review time against the 3-minute target.

const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
const ADMIN = { 'x-admin-token': 'secret' };
const PW = 'correct horse battery';

describe('passwords and helpers', () => {
  it('scrypt hashes verify, salted, wrong passwords fail', async () => {
    const a = await hashPassword(PW), b = await hashPassword(PW);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PW, a)).toBe(true);
    expect(await verifyPassword('correct horse battery!', a)).toBe(false);
    expect(await verifyPassword(PW, 'md5$abc')).toBe(false);
  });

  it('reads the session cookie, summarises review times', () => {
    expect(readCookie('a=1; hok_desk=xyz; b=2')).toBe('xyz');
    expect(readCookie('hok_deskx=1')).toBeNull();
    expect(reviewTimes([60, 120, 600, 30])).toEqual({ reviews: 4, medianS: 60, p90S: 600, withinTarget: 0.75, targetS: 180 });
    expect(reviewTimes([])).toMatchObject({ reviews: 0, medianS: null, withinTarget: null });
  });
});

describe.each(storeBackends())('Alert Desk accounts ($name)', (backend) => {
  let store: Store, pipeline: Pipeline, clock: Date;
  beforeEach(async () => {
    store = await backend.make();
    clock = new Date('2026-11-23T10:00:00+01:00');
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => clock });
  });
  afterEach(async () => { await store.close(); });

  const app = () => buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock });
  const login = async (a: ReturnType<typeof app>, email = 'anna@heyokay.de', password = PW) =>
    a.inject({ method: 'POST', url: '/admin/api/login', payload: { email, password } });
  const asReviewer = (cookie: string) => ({ cookie: `hok_desk=${cookie}`, 'x-desk': '1' });

  it('only the admin token manages reviewers; passwords ≥ 12; no hashes leave the server', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/admin/api/reviewers', payload: { email: 'anna@heyokay.de', name: 'Anna', password: PW } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/admin/api/reviewers', headers: ADMIN, payload: { email: 'anna@heyokay.de', name: 'Anna', password: 'short' } })).statusCode).toBe(400);
    const created = await a.inject({ method: 'POST', url: '/admin/api/reviewers', headers: ADMIN, payload: { email: 'Anna@HeyOkay.de', name: 'Anna', password: PW } });
    expect(created.json()).toMatchObject({ email: 'anna@heyokay.de', name: 'Anna', disabled: false });
    expect(created.body).not.toContain('scrypt');
    expect((await a.inject({ method: 'POST', url: '/admin/api/reviewers', headers: ADMIN, payload: { email: 'anna@heyokay.de', name: 'A', password: PW } })).statusCode).toBe(409);
    const list = await a.inject({ method: 'GET', url: '/admin/api/reviewers', headers: ADMIN });
    expect(list.json().reviewers).toHaveLength(1);
    expect(list.body).not.toContain('scrypt');

    // A signed-in reviewer can't add reviewers.
    const cookie = readCookie((await login(a)).headers['set-cookie'] as string)!;
    expect((await a.inject({ method: 'GET', url: '/admin/api/reviewers', headers: asReviewer(cookie) })).statusCode).toBe(403);
  });

  it('signs in with a safe cookie; approvals name the reviewer and their review time; sign-out and switch-off end sessions', async () => {
    const a = app();
    await a.inject({ method: 'POST', url: '/admin/api/reviewers', headers: ADMIN, payload: { email: 'anna@heyokay.de', name: 'Anna', password: PW } });
    expect((await login(a, 'anna@heyokay.de', 'wrong password!!')).statusCode).toBe(401);
    expect((await login(a, 'nobody@heyokay.de')).statusCode).toBe(401);

    const ok = await login(a);
    expect(ok.json()).toEqual({ reviewer: { email: 'anna@heyokay.de', name: 'Anna' } });
    const setCookie = ok.headers['set-cookie'] as string;
    expect(setCookie).toMatch(/^hok_desk=[\w-]{40,};/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/admin', 'Max-Age=43200']) expect(setCookie).toContain(flag);
    const cookie = readCookie(setCookie)!;

    expect((await a.inject({ method: 'GET', url: '/admin/api/me', headers: asReviewer(cookie) })).json()).toMatchObject({ actor: 'anna@heyokay.de', admin: false });
    // Without the x-desk header (what a form on another site would send) the cookie isn't enough.
    expect((await a.inject({ method: 'GET', url: '/admin/api/pending', headers: { cookie: `hok_desk=${cookie}` } })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/admin/api/pending', headers: { ...asReviewer(cookie), 'x-admin-token': 'wrong' } })).statusCode).toBe(401);

    const item: SourceItem = { source: 'rss', sourceName: 'Polizei Berlin', externalId: 'a', official: false, title: 'Großbrand in Friedrichshain', body: 'In Friedrichshain brennt eine Halle.', publishedAt: clock.toISOString() };
    await pipeline.ingest([item]);
    const [event] = await store.eventsByStatus('pending_review');
    expect(event.reviewRequestedAt).toBe(clock.toISOString());
    clock = new Date(clock.getTime() + 150_000); // 2.5 minutes later
    expect((await a.inject({ method: 'POST', url: `/admin/api/events/${event.id}/approve`, headers: asReviewer(cookie), payload: {} })).statusCode).toBe(200);
    const [desk] = await store.decisions({ kind: 'desk' });
    expect(desk).toMatchObject({ actor: 'anna@heyokay.de', outcome: 'approved', detail: { reviewSeconds: 150 } });

    const rt = (await a.inject({ method: 'GET', url: '/admin/api/review-time', headers: asReviewer(cookie) })).json();
    expect(rt).toMatchObject({ days: 7, reviews: 1, medianS: 150, withinTarget: 1, targetS: 180, byReviewer: [{ reviewer: 'anna@heyokay.de', reviews: 1 }] });

    // Sign out: that cookie stops working.
    await a.inject({ method: 'POST', url: '/admin/api/logout', headers: asReviewer(cookie) });
    expect((await a.inject({ method: 'GET', url: '/admin/api/me', headers: asReviewer(cookie) })).statusCode).toBe(401);

    // Switched off: their other sessions end, and they can't sign in again.
    const again = readCookie((await login(a)).headers['set-cookie'] as string)!;
    const [anna] = await store.reviewers();
    await a.inject({ method: 'PUT', url: `/admin/api/reviewers/${anna.id}`, headers: ADMIN, payload: { disabled: true } });
    expect((await a.inject({ method: 'GET', url: '/admin/api/me', headers: asReviewer(again) })).statusCode).toBe(401);
    expect((await login(a)).statusCode).toBe(401);

    // Sessions expire after 12 hours.
    await a.inject({ method: 'PUT', url: `/admin/api/reviewers/${anna.id}`, headers: ADMIN, payload: { disabled: false } });
    const late = readCookie((await login(a)).headers['set-cookie'] as string)!;
    clock = new Date(clock.getTime() + 12 * 3600_000 + 1000);
    expect((await a.inject({ method: 'GET', url: '/admin/api/me', headers: asReviewer(late) })).statusCode).toBe(401);
  });

  it('five wrong passwords lock that email for 15 minutes, even with the right one', async () => {
    const a = app();
    await a.inject({ method: 'POST', url: '/admin/api/reviewers', headers: ADMIN, payload: { email: 'anna@heyokay.de', name: 'Anna', password: PW } });
    for (let i = 0; i < 5; i++) expect((await login(a, 'anna@heyokay.de', `wrong password ${i}`)).statusCode).toBe(401);
    expect((await login(a)).statusCode).toBe(429);
    clock = new Date(clock.getTime() + 15 * 60_000 + 1000);
    expect((await login(a)).statusCode).toBe(200);
  });

  it('the admin token still works and acts as "desk"', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/admin/api/me', headers: ADMIN })).json()).toMatchObject({ actor: 'desk', admin: true, reviewer: null });
    expect((await a.inject({ method: 'GET', url: '/admin/api/pending', headers: { 'x-admin-token': 'secreT' } })).statusCode).toBe(401);
  });
});
