import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../lib/api';
import { geocodeAddress, roundCoord } from '../lib/location';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test('sends the device token and JSON; ids in paths are encoded', async () => {
  const { f, calls } = fakeFetch(200, { ok: true });
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await api.feedback('a/b', 'relevant');
  assert.equal(calls[0].url, 'https://srv.test/v1/alerts/a%2Fb/feedback');
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.authorization, 'Bearer tok');
  assert.equal(h['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { value: 'relevant' });
});

test('registering needs no token and sends no push token (the browser gets none)', async () => {
  const { f, calls } = fakeFetch(200, { userId: 'u', token: 't', prefs: {} });
  const api = createApi(f, () => null, 'https://srv.test');
  await api.register({ categories: ['weather'], quietHours: null, dailyLimit: 3, timezone: 'Europe/Berlin', language: 'en' });
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined);
  assert.equal(JSON.parse(String(calls[0].init.body)).pushToken, null);
});

test('errors carry the status; no token means 401 without a request', async () => {
  const { f, calls } = fakeFetch(404, { error: 'not_found' });
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await assert.rejects(api.alert('x'), (e: unknown) => e instanceof ApiError && e.status === 404 && e.message === 'not_found');
  const none = createApi(f, () => null, 'https://srv.test');
  await assert.rejects(none.alerts(), (e: unknown) => e instanceof ApiError && e.status === 401);
  assert.equal(calls.length, 1);
});

test('locations are rounded to about 100 m; address search is limited to Germany', async () => {
  assert.equal(roundCoord(52.520008), 52.52);
  assert.equal(roundCoord(13.404954), 13.405);
  const { f, calls } = fakeFetch(200, [{ lat: '53.551086', lon: '9.993682' }]);
  assert.deepEqual(await geocodeAddress('Rathausmarkt 1, Hamburg', f), { lat: 53.551, lon: 9.994 });
  assert.match(calls[0].url, /countrycodes=de/);
  const empty = fakeFetch(200, []);
  assert.equal(await geocodeAddress('nirgendwo', empty.f), null);
});
