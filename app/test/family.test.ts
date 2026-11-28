import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canInvite, canRemove, FAMILY_MAX, familyErrorKey, formatCode, inviteDate, normalizeCode, othersPlaces, validName, type Family,
} from '../src/lib/family.ts';
import { createApi } from '../src/lib/api-client.ts';

// Family sharing in the phone app (PRD 6.1 #8). lib/family.ts is the same file on the web.

const family = (over: Partial<Family> = {}): Family => ({
  admin: true, max: FAMILY_MAX,
  members: [
    { id: 'm1', name: 'Mama', you: true, admin: true, joinedAt: '2026-11-27T08:00:00Z' },
    { id: 'm2', name: 'Lena', you: false, admin: false, joinedAt: '2026-11-27T09:00:00Z' },
  ],
  places: [
    { id: 'p1', label: 'Zuhause', memberId: 'm1' },
    { id: 'p2', label: 'Schule', memberId: 'm2' },
    { id: 'p3', label: 'Alt', memberId: 'gone' },
  ],
  ...over,
});

test('codes: typing is forgiving, the same alphabet as the server', () => {
  assert.equal(formatCode('k7qd'), 'K7QD');
  assert.equal(formatCode('k7qdm'), 'K7QD-M');
  assert.equal(formatCode('k7 qd-m2xr extra'), 'K7QD-M2XR');
  assert.equal(formatCode('O0I1'), ''); // never in a code
  assert.equal(normalizeCode(' k7qd m2xr '), 'K7QDM2XR');
  assert.equal(normalizeCode('K7QD-M2X'), null);
  const server = readFileSync(new URL('../../server/src/family.ts', import.meta.url), 'utf8');
  const alphabet = server.match(/CODE_ALPHABET = '([A-Z0-9]+)'/)![1];
  for (const c of alphabet) assert.equal(formatCode(c), c);
  assert.equal(formatCode('01IO'), '');
  assert.match(server, new RegExp(`FAMILY_MAX = ${FAMILY_MAX};`));
});

test('names and error messages', () => {
  assert.ok(validName(' Mama '));
  assert.ok(!validName('   '));
  assert.ok(!validName('x'.repeat(31)));
  assert.equal(familyErrorKey(400, 'invalid_code'), 'fam.err.code');
  assert.equal(familyErrorKey(409, 'family_full'), 'fam.err.full');
  assert.equal(familyErrorKey(409, 'already_in_family'), 'fam.err.already');
  assert.equal(familyErrorKey(400, 'Bad Request'), 'fam.err.name');
  assert.equal(familyErrorKey(500, ''), 'fam.err.generic');
});

test('who may do what; the others\' places with whose they are', () => {
  const f = family();
  assert.ok(canInvite(f));
  assert.ok(!canInvite(family({ admin: false })));
  assert.ok(!canInvite(family({ members: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, name: `P${i}`, you: i === 0, admin: i === 0, joinedAt: '' })) })));
  assert.ok(!canRemove(f, f.members[0])); // yourself: leave instead
  assert.ok(canRemove(f, f.members[1]));
  assert.ok(!canRemove(family({ admin: false }), f.members[1]));
  // Your own shared places show under "Saved places"; a place of someone no longer listed doesn't show.
  assert.deepEqual(othersPlaces(f), [{ id: 'p2', label: 'Schule', by: 'Lena' }]);
  assert.match(inviteDate({ code: 'x', expiresAt: '2026-12-04T10:00:00Z' }, 'de-DE'), /4\.\s*Dez/);
});

test('API: share switch and family calls', async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await api.sharePlace('a/b', true);
  await api.family();
  await api.startFamily('Mama');
  await api.familyInvite();
  await api.joinFamily('K7QDM2XR', 'Lena');
  await api.leaveFamily();
  await api.removeFamilyMember('m/2');
  assert.deepEqual(calls.map((c) => [c.method, c.url.replace('https://srv.test', ''), c.body]), [
    ['PATCH', '/v1/me/places/a%2Fb', { shared: true }],
    ['GET', '/v1/me/family', undefined],
    ['POST', '/v1/me/family', { name: 'Mama' }],
    ['POST', '/v1/me/family/invite', {}],
    ['POST', '/v1/me/family/join', { code: 'K7QDM2XR', name: 'Lena' }],
    ['DELETE', '/v1/me/family', undefined],
    ['DELETE', '/v1/me/family/members/m%2F2', undefined],
  ]);
});

test('every family string in German, English and Tamil, calm, and the same on the web', () => {
  const app = readFileSync(new URL('../src/lib/i18n.ts', import.meta.url), 'utf8');
  const ta = readFileSync(new URL('../src/lib/i18n-ta.ts', import.meta.url), 'utf8');
  const web = readFileSync(new URL('../../web/lib/app-strings.ts', import.meta.url), 'utf8');
  const webTa = readFileSync(new URL('../../web/lib/strings-ta.ts', import.meta.url), 'utf8');
  const family = readFileSync(new URL('../src/components/FamilySection.tsx', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/app/settings.tsx', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/lib/family.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/components/CheckinCard.tsx', import.meta.url), 'utf8');
  const keys = [...new Set([...family.matchAll(/'((?:fam|set\.places)\.[a-zA-Z.]+)'/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 25, `${keys.length} keys`);
  const lines = (src: string) => [...src.matchAll(/^ {2}'((?:fam|set\.places)\.[^']+)': (.+),$/gm)].map((m) => `${m[1]}=${m[2]}`);
  for (const k of keys) {
    assert.equal(app.split(`'${k}':`).length - 1, 2, `de + en ${k}`);
    assert.equal(ta.split(`'${k}':`).length - 1, 1, `ta ${k}`);
  }
  // The web's copy says exactly the same.
  assert.deepEqual(lines(web).sort(), lines(app).sort());
  assert.deepEqual(lines(webTa).sort(), lines(ta).sort());
  for (const l of lines(app)) assert.doesNotMatch(l, /\b(panik|gefahr!|alarm!|danger!|warning!)/i);
});

test('lib/family.ts is the same file on the web', () => {
  assert.equal(readFileSync(new URL('../src/lib/family.ts', import.meta.url), 'utf8'), readFileSync(new URL('../../web/lib/family.ts', import.meta.url), 'utf8'));
});
