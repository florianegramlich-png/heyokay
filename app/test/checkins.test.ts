import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerKey, answerTime, CHECKIN_ANSWERS, checkinForAlert, checkinToShow, familyAnswers, FAMILY_MAX, type Checkin, type Family } from '../src/lib/family.ts';
import { ALERT_CATEGORY, CHECKIN_CATEGORY, pushTarget } from '../src/lib/push-target.ts';
import { createApi } from '../src/lib/api-client.ts';

// "Hey, okay?" check-ins in the phone app (PRD 6.1 #8). lib/family.ts is the same file on the web.

const NOW = Date.parse('2026-11-28T14:00:00Z');
const ci = (over: Partial<Checkin> = {}): Checkin => ({
  id: 'c1', alertId: 'a1', title: 'Großbrand', askedAt: '2026-11-28T13:00:00Z', answer: null, answeredAt: null, emergency: '112', ...over,
});

test('the card shows the open check-in, or a fresh answer for a while', () => {
  assert.equal(checkinToShow([], NOW), null);
  const open = ci({ id: 'open', askedAt: '2026-11-28T10:00:00Z' });
  const answered = ci({ id: 'done', askedAt: '2026-11-28T13:00:00Z', answer: 'ok', answeredAt: '2026-11-28T13:30:00Z' });
  assert.equal(checkinToShow([answered, open], NOW)?.id, 'open'); // unanswered first, even if older
  assert.equal(checkinToShow([answered], NOW)?.id, 'done');
  assert.equal(checkinToShow([answered], NOW + 2 * 3600_000), null); // two hours after answering: gone
  assert.equal(checkinForAlert([open, ci({ id: 'x', alertId: 'a2' })], 'a2')?.id, 'x');
  assert.equal(checkinForAlert([open], 'nope'), null);
});

test('the family sees the others\' latest answers with names, newest first', () => {
  const f: Family = {
    admin: true, max: FAMILY_MAX, places: [],
    members: [
      { id: 'm1', name: 'Mama', you: true, admin: true, joinedAt: '' },
      { id: 'm2', name: 'Lena', you: false, admin: false, joinedAt: '' },
      { id: 'm3', name: 'Papa', you: false, admin: false, joinedAt: '' },
    ],
    checkins: [
      { memberId: 'm1', answer: 'ok', answeredAt: '2026-11-28T13:10:00Z' }, // you: not listed
      { memberId: 'm2', answer: 'ok', answeredAt: '2026-11-28T13:05:00Z' },
      { memberId: 'm3', answer: 'call_me', answeredAt: '2026-11-28T13:20:00Z' },
      { memberId: 'gone', answer: 'ok', answeredAt: '2026-11-28T13:30:00Z' },
    ],
  };
  assert.deepEqual(familyAnswers(f).map((a) => [a.name, a.answer]), [['Papa', 'call_me'], ['Lena', 'ok']]);
  assert.deepEqual(familyAnswers({ ...f, checkins: undefined }), []); // an older server
  assert.equal(answerKey('ok'), 'fam.ci.ok');
  assert.equal(answerKey('call_me'), 'fam.ci.callMe');
  assert.deepEqual([...CHECKIN_ANSWERS], ['ok', 'call_me']);
  assert.match(answerTime('2026-11-28T13:05:00Z', 'de-DE', new Date(NOW)), /^\d{2}:\d{2}$/);
  assert.match(answerTime('2026-11-25T13:05:00Z', 'de-DE', new Date(NOW)), /, \d{2}:\d{2}$/);
});

test('notification taps: rate, answer a check-in, open the alert or the family', () => {
  const ask = { alertId: 'a1', eventId: 'e1', checkinId: 'c1', url: 'heyokay://alert/a1' };
  assert.deepEqual(pushTarget(ask, 'ok'), { kind: 'checkin', checkinId: 'c1', answer: 'ok', alertId: 'a1' });
  assert.deepEqual(pushTarget(ask, 'call_me'), { kind: 'checkin', checkinId: 'c1', answer: 'call_me', alertId: 'a1' });
  assert.deepEqual(pushTarget(ask, 'expo.modules.notifications.actions.DEFAULT'), { kind: 'open', alertId: 'a1' });
  assert.deepEqual(pushTarget({ alertId: 'a1' }, 'relevant'), { kind: 'rate', alertId: 'a1', value: 'relevant' });
  assert.deepEqual(pushTarget({ alertId: 'a1' }, 'ok'), { kind: 'open', alertId: 'a1' }); // no check-in on it
  assert.deepEqual(pushTarget({ checkinId: 'c1', url: 'heyokay://family' }, 'x'), { kind: 'family' });
  assert.equal(pushTarget({}, 'ok'), null);
  assert.equal(pushTarget(undefined, 'x'), null);
});

test('categories and button ids match the server', () => {
  const push = readFileSync(new URL('../../server/src/push.ts', import.meta.url), 'utf8');
  assert.match(push, new RegExp(`CHECKIN_CATEGORY = '${CHECKIN_CATEGORY}'`));
  assert.match(push, new RegExp(`categoryId: '${ALERT_CATEGORY}'`));
  const server = readFileSync(new URL('../../server/src/checkins.ts', import.meta.url), 'utf8');
  assert.match(server, /CHECKIN_ANSWERS = \['ok', 'call_me'\]/);
  const notif = readFileSync(new URL('../src/lib/notifications.ts', import.meta.url), 'utf8');
  for (const a of CHECKIN_ANSWERS) assert.match(notif, new RegExp(`identifier: '${a}'`));
});

test('API: check-ins', async () => {
  const calls: Array<[string, string, unknown]> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push([init.method!, url.replace('https://srv.test', ''), init.body ? JSON.parse(String(init.body)) : undefined]);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await api.checkins();
  await api.answerCheckin('c/1', 'call_me');
  assert.deepEqual(calls, [['GET', '/v1/me/checkins', undefined], ['POST', '/v1/me/checkins/c%2F1', { answer: 'call_me' }]]);
});
