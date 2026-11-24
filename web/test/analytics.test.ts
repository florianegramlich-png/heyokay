import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_EVENTS, createAnalytics, heyOkayProvider } from '../lib/analytics';
import { createApi } from '../lib/api';

// PRD 13: the same analytics module as the phone app (app/src/lib/analytics.ts).

test('web: onboarding events go to POST /v1/events without a token, platform "web", names only', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const api = createApi(fake, () => null, 'https://api.test');
  const a = createAnalytics([heyOkayProvider('web', (b) => api.events(b), { delayMs: 0 })]);
  a.track('onb_value');
  a.permission('location', 'later');
  a.track('onb_done');
  await a.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/v1/events');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    platform: 'web', events: [{ name: 'onb_value' }, { name: 'perm_location_later' }, { name: 'onb_done' }],
  });
});

test('web and phone app share one module with the same event names', async () => {
  const { readFile } = await import('node:fs/promises');
  const here = new URL('.', import.meta.url);
  const [web, app] = await Promise.all([
    readFile(new URL('../lib/analytics.ts', here), 'utf8'),
    readFile(new URL('../../app/src/lib/analytics.ts', here), 'utf8'),
  ]);
  assert.equal(web, app);
  assert.ok(APP_EVENTS.includes('onb_categories'));
});
