import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../src/lib/api-client.ts';

// lib/api: the app's server calls, without Expo (lib/api.ts only wires in the session and the URL).

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText: status === 503 ? 'Service Unavailable' : '' });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const headers = (c: { init: RequestInit }) => c.init.headers as Record<string, string>;

test('sends the device token (also when the session gives it asynchronously) and JSON; ids in paths are encoded', async () => {
  const { f, calls } = fakeFetch(200, { ok: true });
  const api = createApi(f, async () => 'tok', 'https://srv.test');
  await api.feedback('a/b', 'relevant');
  assert.equal(calls[0].url, 'https://srv.test/v1/alerts/a%2Fb/feedback');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(headers(calls[0]).authorization, 'Bearer tok');
  assert.equal(headers(calls[0])['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { value: 'relevant' });
  await api.deletePlace('p 1');
  assert.equal(calls[1].url, 'https://srv.test/v1/me/places/p%201');
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(calls[1].init.body, undefined);
  assert.equal(headers(calls[1])['content-type'], undefined, 'no body, no content type');
});

test('registering and the public calls send no token; registering sends the push token', async () => {
  const { f, calls } = fakeFetch(200, { userId: 'u', token: 't', prefs: {} });
  const api = createApi(f, () => { throw new Error('must not ask for a token'); }, 'https://srv.test');
  await api.register({ categories: ['weather'], quietHours: null, dailyLimit: 3, timezone: 'Europe/Berlin', language: 'de' } as never, 'ExponentPushToken[x]');
  await api.events({ platform: 'ios', events: [{ name: 'onb_value' }] });
  await api.authProviders();
  await api.services();
  assert.deepEqual(calls.map((c) => c.url.replace('https://srv.test', '')), ['/v1/devices', '/v1/events', '/v1/auth/providers', '/v1/services']);
  for (const c of calls) assert.equal(headers(c).authorization, undefined);
  assert.equal(JSON.parse(String(calls[0].init.body)).pushToken, 'ExponentPushToken[x]');
});

test('history builds its query only from what is set', async () => {
  const { f, calls } = fakeFetch(200, { alerts: [] });
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await api.history();
  await api.history({ q: 'Sturm & Regen', category: 'weather' });
  assert.equal(calls[0].url, 'https://srv.test/v1/me/history');
  assert.equal(calls[1].url, 'https://srv.test/v1/me/history?q=Sturm+%26+Regen&category=weather');
});

test('errors carry the status and the server\'s message; no token means 401 without a request', async () => {
  const { f, calls } = fakeFetch(404, { error: 'not_found' });
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await assert.rejects(api.alert('x'), (e: unknown) => e instanceof ApiError && e.status === 404 && e.message === 'not_found');
  const none = createApi(f, async () => null, 'https://srv.test');
  await assert.rejects(none.alerts(), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(calls.length, 1);
  // A body that isn't JSON (a proxy's error page) still gives an ApiError with the status text.
  const html = fakeFetch(503, '<html>down</html>');
  await assert.rejects(createApi(html.f, () => 'tok', 'https://srv.test').me(), (e: unknown) => e instanceof ApiError && e.status === 503 && e.message === 'Service Unavailable');
});
