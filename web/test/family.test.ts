import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApi } from '../lib/api';
import { translate } from '../lib/i18n';
import { APP_STRINGS } from '../lib/app-strings';
import { canInvite, formatCode, normalizeCode, othersPlaces, type Family } from '../lib/family';

// Family sharing on the web (PRD 6.1 #8): the same module and strings as the phone app.

test('the same module as the phone app', () => {
  assert.equal(readFileSync(new URL('../lib/family.ts', import.meta.url), 'utf8'), readFileSync(new URL('../../app/src/lib/family.ts', import.meta.url), 'utf8'));
  assert.equal(formatCode('k7qdm2xr'), 'K7QD-M2XR');
  assert.equal(normalizeCode('K7QD-M2XR'), 'K7QDM2XR');
  const f: Family = {
    admin: false, max: 6, members: [{ id: 'a', name: 'Mama', you: false, admin: true, joinedAt: '' }, { id: 'b', name: 'Lena', you: true, admin: false, joinedAt: '' }],
    places: [{ id: 'p', label: 'Zuhause', memberId: 'a' }, { id: 'q', label: 'Schule', memberId: 'b' }],
  };
  assert.ok(!canInvite(f));
  assert.deepEqual(othersPlaces(f), [{ id: 'p', label: 'Zuhause', by: 'Mama' }]);
});

test('API: share switch and family calls (CORS allows PATCH on the server)', async () => {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push(`${init.method} ${url.replace('https://srv.test', '')} ${init.body ?? ''}`); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await api.sharePlace('p 1', false);
  await api.joinFamily('K7QDM2XR', 'Lena');
  await api.removeFamilyMember('m1');
  assert.deepEqual(calls, [
    'PATCH /v1/me/places/p%201 {"shared":false}',
    'POST /v1/me/family/join {"code":"K7QDM2XR","name":"Lena"}',
    'DELETE /v1/me/family/members/m1 ',
  ]);
  assert.match(readFileSync(new URL('../../server/src/api.ts', import.meta.url), 'utf8'), /methods: \[[^\]]*'PATCH'/);
});

test('family strings in every language; a name can appear twice in one sentence', () => {
  for (const lang of ['de', 'en', 'ta'] as const) {
    for (const k of ['fam.title', 'fam.intro', 'fam.invite.share', 'fam.places.by', 'fam.err.code', 'set.places.share'] as const) {
      assert.ok(APP_STRINGS[lang][k]?.length > 0, `${lang} ${k}`);
    }
  }
  assert.equal(translate('de', 'fam.remove.confirm', { name: 'Lena' }), 'Lena aus der Familie nehmen? Was Lena geteilt hat, ist dann nicht mehr geteilt.');
  assert.match(translate('en', 'fam.invite.share', { code: 'K7QD-M2XR', date: 'Dec 4' }), /K7QD-M2XR \(valid until Dec 4\)/);
});
