import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_EVENTS, BATCH, MAX_QUEUE, createAnalytics, heyOkayProvider, pushChange, type AnalyticsProvider, type AppEvent } from '../src/lib/analytics.ts';

// PRD 13: anonymous app events behind a provider abstraction (same module as web/lib/analytics.ts).

test('sends names and the platform only, in batches of 20; a failed send is dropped', async () => {
  const sent: unknown[] = [];
  let fail = false;
  const p = heyOkayProvider('ios', async (body) => { if (fail) throw new Error('offline'); sent.push(body); }, { delayMs: 0 });
  const a = createAnalytics([p]);
  for (let i = 0; i < BATCH + 5; i++) a.track('onb_value');
  a.permission('location', true);
  a.permission('push', false);
  a.permission('background', 'later');
  await a.flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(Object.keys(sent[0] as object).sort(), ['events', 'platform']);
  const names = (sent as { events: { name: string }[] }[]).flatMap((b) => b.events.map((e) => e.name));
  assert.equal(names.length, BATCH + 8);
  assert.deepEqual(names.slice(-3), ['perm_location_granted', 'perm_push_denied', 'perm_background_later']);
  assert.ok((sent[0] as { events: unknown[] }).events.every((e) => Object.keys(e as object).join() === 'name'));

  fail = true;
  a.track('onb_done');
  await a.flush(); // no throw
  fail = false;
  await a.flush();
  assert.equal(sent.length, 2, 'dropped, not retried');
});

test('the queue is capped while offline; unknown names and broken providers are ignored', async () => {
  let count = 0;
  const p = heyOkayProvider('web', async (b) => { count += b.events.length; }, { delayMs: 0 });
  const broken: AnalyticsProvider = { name: 'broken', track() { throw new Error('x'); }, flush: async () => { throw new Error('y'); } };
  const a = createAnalytics([broken, p]);
  for (let i = 0; i < MAX_QUEUE + 50; i++) a.track('onb_location');
  a.track('not_an_event' as AppEvent);
  await a.flush();
  assert.equal(count, MAX_QUEUE);
});

test('sends by itself after the delay', async () => {
  let got = 0;
  const p = heyOkayProvider('android', async (b) => { got += b.events.length; }, { delayMs: 5 });
  p.track('onb_consent');
  p.track('onb_done');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got, 2);
});

test('notifications switched off or on again in the phone settings', () => {
  assert.equal(pushChange(null, true), null);
  assert.equal(pushChange(true, true), null);
  assert.equal(pushChange(true, false), 'push_turned_off');
  assert.equal(pushChange(false, true), 'push_turned_on');
  assert.ok(APP_EVENTS.includes('push_turned_off'));
});
