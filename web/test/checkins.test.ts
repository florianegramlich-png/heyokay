import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApi } from '../lib/api';
import { translate } from '../lib/i18n';
import { checkinToShow, familyAnswers, type Checkin, type Family } from '../lib/family';

// "Hey, okay?" check-ins on the web (PRD 6.1 #8): the same module and strings as the phone app.
// A browser has no notification buttons, so the card on the Now page is where web users answer.

test('the card and the family answers come from the shared module', () => {
  const now = Date.parse('2026-11-28T14:00:00Z');
  const c: Checkin = { id: 'c', alertId: 'a', title: 'Sturm', askedAt: '2026-11-28T13:00:00Z', answer: null, answeredAt: null, emergency: '911' };
  assert.equal(checkinToShow([c], now)?.id, 'c');
  const f: Family = {
    admin: false, max: 6, places: [],
    members: [{ id: 'a', name: 'Mama', you: false, admin: true, joinedAt: '' }, { id: 'b', name: 'Lena', you: true, admin: false, joinedAt: '' }],
    checkins: [{ memberId: 'a', answer: 'call_me', answeredAt: '2026-11-28T13:00:00Z' }, { memberId: 'b', answer: 'ok', answeredAt: '2026-11-28T13:01:00Z' }],
  };
  assert.deepEqual(familyAnswers(f).map((x) => `${x.name}:${x.answer}`), ['Mama:call_me']);
});

test('API: check-ins', async () => {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push(`${init.method} ${url.replace('https://srv.test', '')} ${init.body ?? ''}`); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await api.checkins();
  await api.answerCheckin('c1', 'ok');
  assert.deepEqual(calls, ['GET /v1/me/checkins ', 'POST /v1/me/checkins/c1 {"answer":"ok"}']);
});

test('every string the card uses exists in German, English and Tamil, with the number filled in', () => {
  const card = readFileSync(new URL('../components/checkin-card.tsx', import.meta.url), 'utf8')
    + readFileSync(new URL('../components/family-section.tsx', import.meta.url), 'utf8');
  const keys = [...new Set([...card.matchAll(/'(fam\.ci\.[a-zA-Z]+)'/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 7, `${keys.length} keys`);
  for (const lang of ['de', 'en', 'ta'] as const) for (const k of keys) assert.notEqual(translate(lang, k as never), k, `${lang} ${k}`);
  assert.equal(translate('de', 'fam.ci.emergency' as never, { number: '112' }), 'Wenn es ein Notfall ist: 112 anrufen.');
  assert.equal(translate('en', 'fam.ci.ok' as never), 'I’m fine');
});
