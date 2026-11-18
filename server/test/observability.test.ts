import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram, Registry, M, registry } from '../src/metrics.js';
import { errorEntry, parseStack, sentrySink } from '../src/errors.js';
import { SqliteStore } from '../src/db.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { buildApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';

describe('Prometheus metrics', () => {
  it('renders counters, gauges and histograms in the text format', async () => {
    const r = new Registry();
    const c = r.add(new Counter('t_total', 'A counter.'));
    const g = r.add(new Gauge('t_depth', 'A gauge.'));
    const h = r.add(new Histogram('t_seconds', 'A histogram.', [1, 5]));
    c.inc({ result: 'ok' }); c.inc({ result: 'ok' }, 2); c.inc({ result: 'error' });
    r.onCollect(async () => g.set({}, 7));
    h.observe({}, 0.5); h.observe({}, 3); h.observe({}, 9);
    const text = await r.render();
    expect(text).toContain('# TYPE t_total counter');
    expect(text).toContain('t_total{result="ok"} 3');
    expect(text).toContain('t_total{result="error"} 1');
    expect(text).toContain('t_depth 7');
    expect(text).toContain('t_seconds_bucket{le="1"} 1');
    expect(text).toContain('t_seconds_bucket{le="5"} 2');
    expect(text).toContain('t_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('t_seconds_sum 12.5');
    expect(text).toContain('t_seconds_count 3');
  });

  it('HTTP requests are counted by route pattern, never by URL', async () => {
    const store = new SqliteStore();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const app = buildApi({ store, pipeline, adminToken: 'x', runIngest: async () => ({}) });
    const before = M.http.get({ route: '/v1/alerts/:id', method: 'GET', status: '4xx' });
    await app.inject({ url: '/v1/alerts/8f3c9a-secret-id' });
    expect(M.http.get({ route: '/v1/alerts/:id', method: 'GET', status: '4xx' })).toBe(before + 1);
    expect(await registry.render()).not.toContain('8f3c9a-secret-id');
    await app.close(); await store.close();
  });

  it('pushes from the delivery queue are counted, with their latency', async () => {
    const store = new SqliteStore();
    let clock = new Date('2026-11-18T10:00:00Z');
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), now: () => clock, config: loadConfig({}) });
    const { user } = await store.createUser('tok');
    const sentBefore = M.pushes.get({ result: 'sent' });
    await store.enqueuePushJobs([{ token: 'tok', attempt: 0, alert: {
      id: 'a', userId: user.id, eventId: 'e', eventRevision: 1, title: 't', body: 'b', action: 'a', category: 'weather', severity: 3,
      official: true, aiWritten: false, sourceName: 'DWD', sourceUrl: null, lat: 0, lon: 0, radiusM: 1, matchedPlace: null,
      delivery: 'push', reason: 'r', kind: 'new', feedback: null, createdAt: '2026-11-18T09:59:58Z' } }], clock.toISOString());
    await pipeline.drainPushQueue();
    expect(M.pushes.get({ result: 'sent' })).toBe(sentBefore + 1);
    expect(await registry.render()).toMatch(/heyokay_push_latency_seconds_bucket\{le="5"\} [1-9]/);
    await store.close();
  });
});

describe('Sentry error sink', () => {
  it('posts one envelope per error to the DSN host, rate-limited per minute', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let t = 1_000_000;
    const sink = sentrySink('https://abc123@o42.ingest.de.sentry.io/4500', {
      environment: 'test', perMinute: 2, now: () => t,
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}'); }) as typeof fetch,
    });
    const entry = errorEntry('http', new Error('boom'), { route: '/v1/me' });
    sink(entry); sink(entry); sink(entry);
    expect(calls).toHaveLength(2);
    t += 61_000; sink(entry);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('https://o42.ingest.de.sentry.io/api/4500/envelope/');
    expect((calls[0].init.headers as Record<string, string>)['X-Sentry-Auth']).toContain('sentry_key=abc123');
    const [head, type, event] = String(calls[0].init.body).trim().split('\n').map((l) => JSON.parse(l));
    expect(type).toEqual({ type: 'event' });
    expect(event.event_id).toBe(head.event_id);
    expect(event).toMatchObject({ level: 'error', environment: 'test', tags: { context: 'http' }, extra: { route: '/v1/me' } });
    expect(event.exception.values[0]).toMatchObject({ type: 'Error', value: 'boom' });
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  });

  it('a network failure never throws into the caller', () => {
    const sink = sentrySink('https://k@o1.ingest.de.sentry.io/1', { fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
    expect(() => sink(errorEntry('x', new Error('y')))).not.toThrow();
  });

  it('parses Node stack lines into frames, oldest first', () => {
    const frames = parseStack('Error: x\n    at inner (/app/dist/a.js:10:5)\n    at /app/node_modules/f/b.js:2:3\n    at node:internal/x:1:1');
    expect(frames.map((f) => [f.function, f.lineno, f.in_app])).toEqual([['?', 1, false], ['?', 2, false], ['inner', 10, true]]);
  });
});
