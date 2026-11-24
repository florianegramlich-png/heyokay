import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import { SqliteStore } from '../src/db.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { RateCounter } from '../src/hardening.js';
import { loadConfig } from '../src/config.js';

// PRD 11: rate limits, body size limit, security headers, and no route falls over on bad input.

let clock = new Date('2026-11-24T10:00:10Z');
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };

function setup(store: Store, hardening = {}, errors: unknown[] = []) {
  const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => clock });
  return buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock, hardening, errorSink: (e) => errors.push(e) });
}

describe('RateCounter', () => {
  it('counts per key in one-minute windows and says how long to wait', () => {
    const c = new RateCounter(2);
    const t = Date.parse('2026-11-24T10:00:50Z');
    expect([c.hit('a', t), c.hit('a', t), c.hit('b', t)]).toEqual([0, 0, 0]);
    expect(c.hit('a', t)).toBe(10);
    expect(c.hit('a', t + 10_000)).toBe(0); // next minute
    expect(new RateCounter(0).hit('a', t)).toBe(0); // off
  });
});

describe('API hardening', () => {
  let store: Store;
  beforeEach(() => { store = new SqliteStore(':memory:'); clock = new Date('2026-11-24T10:00:10Z'); });
  afterEach(async () => { await store.close(); });

  it('security headers everywhere; the desk page gets its own CSP; personal answers are not cached', async () => {
    const app = setup(store);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.headers).toMatchObject({
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    expect(health.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(health.headers['cache-control']).toBeUndefined();
    const desk = await app.inject({ method: 'GET', url: '/admin' });
    expect(desk.headers['content-security-policy']).toMatch(/connect-src 'self'/);
    expect(desk.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    const reg = (await app.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json();
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${reg.token}` } });
    expect(me.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/admin/api/pending', headers: { 'x-admin-token': 'secret' } })).headers['cache-control']).toBe('no-store');
    // CORS for the web app still works.
    const pre = await app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'https://heyokay.app', 'access-control-request-method': 'GET' } });
    expect(pre.statusCode).toBe(204);
  });

  it('bodies over 64 KB are refused', async () => {
    const app = setup(store);
    const res = await app.inject({ method: 'POST', url: '/v1/devices', payload: { prefs: { x: 'a'.repeat(70_000) } } });
    expect(res.statusCode).toBe(413);
  });

  it('per address: the 6th request in a minute gets 429 with Retry-After; /health never; next minute again', async () => {
    const app = setup(store, { ipPerMin: 5, tokenPerMin: 0 });
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/v1/services' })).statusCode).toBe(200);
    const over = await app.inject({ method: 'GET', url: '/v1/services' });
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBe('50');
    expect(over.json()).toEqual({ error: 'too_many_requests' });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    clock = new Date(clock.getTime() + 60_000);
    expect((await app.inject({ method: 'GET', url: '/v1/services' })).statusCode).toBe(200);
  });

  it('per token: one device can\'t flood, others are not affected', async () => {
    const app = setup(store, { ipPerMin: 0, tokenPerMin: 3 });
    const a = (await app.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json().token;
    const b = (await app.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json().token;
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a}` } })).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${b}` } })).statusCode).toBe(200);
  });

  it('the client address comes from our proxy\'s header only when configured', async () => {
    const behindFly = setup(store, { ipPerMin: 1, tokenPerMin: 0, clientIpHeader: 'fly-client-ip' });
    expect((await behindFly.inject({ method: 'GET', url: '/v1/services', headers: { 'fly-client-ip': '203.0.113.1' } })).statusCode).toBe(200);
    expect((await behindFly.inject({ method: 'GET', url: '/v1/services', headers: { 'fly-client-ip': '203.0.113.2' } })).statusCode).toBe(200);
    expect((await behindFly.inject({ method: 'GET', url: '/v1/services', headers: { 'fly-client-ip': '203.0.113.1' } })).statusCode).toBe(429);
    // Without it, a made-up header changes nothing.
    const direct = setup(store, { ipPerMin: 1, tokenPerMin: 0 });
    expect((await direct.inject({ method: 'GET', url: '/v1/services', headers: { 'fly-client-ip': '1.1.1.1' } })).statusCode).toBe(200);
    expect((await direct.inject({ method: 'GET', url: '/v1/services', headers: { 'fly-client-ip': '2.2.2.2' } })).statusCode).toBe(429);
    expect(loadConfig({ FLY_APP_NAME: 'heyokay' }).clientIpHeader).toBe('fly-client-ip');
    expect(loadConfig({}).clientIpHeader).toBeNull();
    expect(loadConfig({ FLY_APP_NAME: 'heyokay', CLIENT_IP_HEADER: 'off' }).clientIpHeader).toBeNull();
  });
});

// ── Fuzz: every route in api.ts with junk input answers 4xx or 2xx, never 500, never crashes ──

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FIELDS = ['lat', 'lon', 'email', 'password', 'code', 'prefs', 'reason', 'severity', 'title', 'body', 'events', 'platform', 'name', 'value', 'radiusM', 'label', 'idToken', 'nonce', 'pushToken', 'quarter', 'category', 'language', 'disabled', 'firstSync', 'q'];
function junk(r: () => number, depth = 0): unknown {
  const pick = Math.floor(r() * 12);
  switch (pick) {
    case 0: return null;
    case 1: return r() < 0.5;
    case 2: return [0, -1, 1e308, -1e308, 2 ** 53 + 1, 0.5, 91, -181][Math.floor(r() * 8)];
    case 3: return ['', ' ', 'a'.repeat(3000), '🙂', '<script>', "'; DROP TABLE users;--", '../../etc/passwd', '\u0000', 'NaN', '2026-13-45', 'x@y', 'ExponentPushToken[x]'][Math.floor(r() * 12)];
    case 4: case 5: if (depth < 3) return Array.from({ length: Math.floor(r() * 4) }, () => junk(r, depth + 1)); return [];
    default: {
      if (depth >= 3) return {};
      const o: Record<string, unknown> = {};
      for (let i = 0; i < 1 + Math.floor(r() * 5); i++) o[FIELDS[Math.floor(r() * FIELDS.length)]] = junk(r, depth + 1);
      if (r() < 0.1) o.__proto__ = { admin: true };
      return o;
    }
  }
}

describe('fuzz every route', () => {
  it('junk bodies, queries and ids never cause a 500', async () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'api.ts'), 'utf8');
    const routes = [...src.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)].map((m) => ({ method: m[1].toUpperCase(), url: m[2] }));
    expect(routes.length).toBeGreaterThan(40);
    const store = new SqliteStore(':memory:');
    const errors: unknown[] = [];
    const app = setup(store, { ipPerMin: 0, tokenPerMin: 0 }, errors);
    const r = rng(20261124);
    const failures: string[] = [];
    const seen = new Map<number, number>();
    for (const route of routes) {
      for (let i = 0; i < 25; i++) {
        // A fresh device for every few requests (some routes delete it).
        const token = i % 5 === 0 || i % 5 === 1 ? (await app.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json().token : null;
        const id = ['x', '00000000-0000-4000-8000-000000000000', '%00', 'a'.repeat(300), '..'][Math.floor(r() * 5)];
        const url = route.url.replace(/:(\w+)/g, () => encodeURIComponent(id));
        const query = r() < 0.5 ? '' : '?' + new URLSearchParams(Object.fromEntries(FIELDS.slice(0, 1 + Math.floor(r() * 6)).map((k) => [k, String(junk(r))]))).toString();
        const headers: Record<string, string> = {};
        if (token) headers.authorization = `Bearer ${token}`;
        if (r() < 0.4) headers['x-admin-token'] = 'secret';
        if (r() < 0.2) { headers.cookie = 'hok_desk=' + 'z'.repeat(40); headers['x-desk'] = '1'; }
        const raw = r() < 0.15;
        const res = await app.inject({
          method: route.method as never, url: url + query, headers: { ...headers, ...(raw ? { 'content-type': 'application/json' } : {}) },
          ...(route.method === 'GET' || route.method === 'DELETE' && r() < 0.5 ? {} : raw ? { payload: ['{', '[1,', 'null', '"x"', '{"a":'][Math.floor(r() * 5)] } : { payload: junk(r) as object }),
        });
        seen.set(res.statusCode, (seen.get(res.statusCode) ?? 0) + 1);
        if (res.statusCode >= 500) failures.push(`${route.method} ${url + query} → ${res.statusCode} ${res.body.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
    // It really exercised the routes: answers, refusals of bad input and of missing auth.
    for (const code of [200, 400, 401, 404]) expect(seen.get(code) ?? 0, `status ${code}: ${JSON.stringify([...seen])}`).toBeGreaterThan(10);
    await store.close();
  }, 120_000);
});
