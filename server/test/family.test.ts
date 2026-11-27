import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { MemoryMailer } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { CODE_ALPHABET, FAMILY_MAX, inviteCodeHash, makeInviteCode, normalizeInviteCode, placeLabel } from '../src/family.js';
import type { RiskEvent } from '../src/types.js';

// PRD 6.1 #8, 3.3 #4: family groups with invite codes (part 1a) and shared places (part 1b).
// Places, never people's locations.

const OSTKREUZ = { lat: 52.503, lon: 13.469 };
function event(id: string, over: Partial<RiskEvent> = {}): RiskEvent {
  const now = new Date().toISOString();
  return {
    id, revision: 1, status: 'auto', category: 'transit', severity: 3, confidence: 0.9, official: false,
    title: 'S-Bahn gesperrt', summary: 'Ostkreuz gesperrt', facts: '', areaName: 'Ostkreuz',
    ...OSTKREUZ, radiusM: 800, startsAt: now, endsAt: null,
    sources: [{ sourceName: 'S-Bahn Berlin', externalId: id, title: 'S-Bahn gesperrt', official: false }],
    copyTitle: null, copyBody: null, copyAction: null, copyIsTemplate: false, createdAt: now, updatedAt: now,
    ...over,
  };
}

describe('invite codes', () => {
  it('a family member\'s place says whose it is', () => {
    expect(placeLabel({ label: 'Zuhause' })).toBe('Zuhause');
    expect(placeLabel({ label: 'Zuhause', sharedBy: 'Mama' })).toBe('Zuhause (Mama)');
  });

  it('8 easy-to-read symbols in two groups; typing is forgiving', () => {
    expect(CODE_ALPHABET).toHaveLength(32);
    expect(CODE_ALPHABET).not.toMatch(/[01IO]/);
    const code = makeInviteCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(makeInviteCode(() => new Uint8Array([0, 1, 2, 3, 31, 30, 32, 255]))).toBe('ABCD-98A9');
    expect(normalizeInviteCode(' abcd 98a9 ')).toBe('ABCD98A9');
    expect(normalizeInviteCode('ABCD-98A')).toBeNull();
    expect(normalizeInviteCode('ABCD-98A0')).toBeNull(); // 0 is never in a code
    expect(inviteCodeHash('ABCD98A9')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.each(storeBackends())('family sharing ($name)', (backend) => {
  let store: Store, mailer: MemoryMailer, app: ReturnType<typeof buildApi>, pipeline: Pipeline;
  beforeEach(async () => {
    store = await backend.make();
    mailer = new MemoryMailer();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    app = buildApi({ store, pipeline, adminToken: 'a', runIngest: async () => ({}), mailer, errorSink: () => {} });
  });
  afterEach(async () => { await store.close(); });

  const call = (method: string, url: string, token?: string, payload?: unknown) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const device = async () => (await call('POST', '/v1/devices', undefined, {})).json().token as string;
  const invite = async (t: string) => (await call('POST', '/v1/me/family/invite', t, {})).json().code as string;

  it('start a family, invite with a code, join; everyone sees names, never ids or places', async () => {
    const mama = await device(), kid = await device();
    expect((await call('GET', '/v1/me/family', mama)).json()).toEqual({ family: null });
    const created = await call('POST', '/v1/me/family', mama, { name: ' Mama ' });
    expect(created.statusCode).toBe(200);
    expect(created.json().family).toMatchObject({ admin: true, max: FAMILY_MAX, members: [{ name: 'Mama', you: true, admin: true }] });

    const inv = await call('POST', '/v1/me/family/invite', mama, {});
    expect(inv.statusCode).toBe(200);
    const { code, expiresAt } = inv.json();
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    const joined = await call('POST', '/v1/me/family/join', kid, { code: code.toLowerCase().replace('-', ' '), name: 'Lena' });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().family.admin).toBe(false);
    expect(joined.json().family.members.map((m: any) => [m.name, m.you, m.admin])).toEqual([['Mama', false, true], ['Lena', true, false]]);

    const seen = (await call('GET', '/v1/me/family', mama)).json().family;
    expect(seen.members).toHaveLength(2);
    for (const m of seen.members) expect(Object.keys(m).sort()).toEqual(['admin', 'id', 'joinedAt', 'name', 'you']);
    expect(seen.places).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain((await call('GET', '/v1/me', kid)).json().userId);
  });

  it('codes work once, expire, and a new code replaces the old one', async () => {
    const a = await device(), b = await device(), c = await device();
    await call('POST', '/v1/me/family', a, { name: 'A' });
    const first = await invite(a);
    const second = await invite(a);
    expect((await call('POST', '/v1/me/family/join', b, { code: first, name: 'B' })).json()).toEqual({ error: 'invalid_code' });
    expect((await call('POST', '/v1/me/family/join', b, { code: second, name: 'B' })).statusCode).toBe(200);
    expect((await call('POST', '/v1/me/family/join', c, { code: second, name: 'C' })).statusCode).toBe(400); // used
    expect((await call('POST', '/v1/me/family/join', c, { code: 'nonsense', name: 'C' })).json()).toEqual({ error: 'invalid_code' });

    const third = await invite(a);
    const fam = (await store.familyMemberByUser((await store.userByToken(a))!.id))!.familyId;
    const later = new Date(Date.now() + 8 * 86_400_000).toISOString();
    expect(await store.takeFamilyInvite(inviteCodeHash(normalizeInviteCode(third)!), later)).toBeNull(); // expired
    expect((await store.purgeExpired(later)).familyInvites).toBe(1);
    expect((await call('POST', '/v1/me/family/join', c, { code: third, name: 'C' })).statusCode).toBe(400);
    expect((await store.familyMembers(fam))).toHaveLength(2);
  });

  it('one family per person, at most six; only the admin invites and removes', async () => {
    const admin = await device();
    await call('POST', '/v1/me/family', admin, { name: 'Admin' });
    expect((await call('POST', '/v1/me/family', admin, { name: 'Again' })).json()).toEqual({ error: 'already_in_family' });
    const others: string[] = [];
    for (let i = 1; i < FAMILY_MAX; i++) {
      const t = await device();
      expect((await call('POST', '/v1/me/family/join', t, { code: await invite(admin), name: `P${i}` })).statusCode).toBe(200);
      others.push(t);
    }
    expect((await call('POST', '/v1/me/family/invite', admin, {})).json()).toEqual({ error: 'family_full' });
    expect((await call('POST', '/v1/me/family/invite', others[0], {})).json()).toEqual({ error: 'not_admin' });
    expect((await call('POST', '/v1/me/family/join', others[0], { code: 'ABCD-EFGH', name: 'x' })).json()).toEqual({ error: 'already_in_family' });

    const members = (await call('GET', '/v1/me/family', admin)).json().family.members;
    expect((await call('DELETE', `/v1/me/family/members/${members[2].id}`, others[0])).statusCode).toBe(403);
    expect((await call('DELETE', `/v1/me/family/members/${members[0].id}`, admin)).json()).toEqual({ error: 'cannot_remove_self' });
    expect((await call('DELETE', '/v1/me/family/members/nobody', admin)).statusCode).toBe(404);
    const after = await call('DELETE', `/v1/me/family/members/${members[2].id}`, admin);
    expect(after.json().family.members).toHaveLength(FAMILY_MAX - 1);
    expect((await call('GET', '/v1/me/family', others[1])).json()).toEqual({ family: null }); // members[2] is others[1]
  });

  it('leaving or deleting your data passes the admin on; the last one out ends the family', async () => {
    const a = await device(), b = await device(), c = await device();
    await call('POST', '/v1/me/family', a, { name: 'A' });
    await call('POST', '/v1/me/family/join', b, { code: await invite(a), name: 'B' });
    await call('POST', '/v1/me/family/join', c, { code: await invite(a), name: 'C' });
    const pending = await invite(a);

    expect((await call('DELETE', '/v1/me', a)).statusCode).toBe(200); // GDPR erasure takes the membership too
    const fb = (await call('GET', '/v1/me/family', b)).json().family;
    expect(fb.admin).toBe(true);
    expect(fb.members.map((m: any) => m.name)).toEqual(['B', 'C']);

    expect((await call('DELETE', '/v1/me/family', b)).statusCode).toBe(200);
    expect((await call('GET', '/v1/me/family', c)).json().family).toMatchObject({ admin: true, members: [{ name: 'C' }] });
    expect((await call('DELETE', '/v1/me/family', b)).json()).toEqual({ error: 'not_in_family' });
    expect((await call('DELETE', '/v1/me/family', c)).statusCode).toBe(200);
    const d = await device();
    expect((await call('POST', '/v1/me/family/join', d, { code: pending, name: 'D' })).statusCode).toBe(400); // family is gone
  });

  it('signing in on a new phone keeps the family', async () => {
    const lastCode = () => mailer.sent.at(-1)!.text.match(/\b(\d{6})\b/)![1];
    const signIn = async (t: string) => {
      await call('POST', '/v1/auth/email/start', t, { email: 'mama@example.org' });
      return call('POST', '/v1/auth/email/verify', t, { email: 'mama@example.org', code: lastCode() });
    };
    const oldPhone = await device(), newPhone = await device(), kid = await device();
    expect((await signIn(oldPhone)).statusCode).toBe(200);
    await call('POST', '/v1/me/family', newPhone, { name: 'Mama' }); // started on the new phone before signing in
    await call('POST', '/v1/me/family/join', kid, { code: await invite(newPhone), name: 'Lena' });
    expect((await signIn(newPhone)).statusCode).toBe(200);
    for (const t of [oldPhone, newPhone]) {
      expect((await call('GET', '/v1/me/family', t)).json().family).toMatchObject({ admin: true, members: [{ name: 'Mama', you: true }, { name: 'Lena' }] });
    }
  });

  it('refuses junk', async () => {
    const t = await device();
    expect((await call('POST', '/v1/me/family', t, { name: '' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/me/family', t, { name: 'x'.repeat(31) })).statusCode).toBe(400);
    expect((await call('POST', '/v1/me/family', t, { name: 'A', userId: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/me/family/join', t, { code: 'x'.repeat(21), name: 'A' })).statusCode).toBe(400);
    expect((await call('GET', '/v1/me/family')).statusCode).toBe(401);
    expect((await call('POST', '/v1/me/family/invite', t, {})).json()).toEqual({ error: 'not_in_family' });
  });

  // ── part 1b: shared places ──
  const userId = async (t: string) => (await call('GET', '/v1/me', t)).json().userId as string;
  const family2 = async () => {
    const mama = await device(), kid = await device();
    await call('POST', '/v1/me/family', mama, { name: 'Mama' });
    await call('POST', '/v1/me/family/join', kid, { code: await invite(mama), name: 'Lena' });
    await store.updateLocation(await userId(kid), 48.137, 11.575); // the kid is in München
    const home = (await call('POST', '/v1/me/places', mama, { label: 'Zuhause', ...OSTKREUZ, radiusM: 500 })).json().place;
    return { mama, kid, home };
  };

  it('a shared place reaches the whole family, labelled with whose it is; never its coordinates', async () => {
    const { mama, kid, home } = await family2();
    expect(home.shared).toBe(false);
    await store.saveEvent(event('before'));
    await pipeline.deliver((await store.getEvent('before'))!);
    expect(await store.alertsForUser(await userId(kid), 10)).toEqual([]); // not shared yet

    expect((await call('PATCH', `/v1/me/places/${home.id}`, kid, { shared: true })).json()).toEqual({ error: 'not_found' }); // not hers
    const shared = await call('PATCH', `/v1/me/places/${home.id}`, mama, { shared: true });
    expect(shared.statusCode).toBe(200);
    expect(shared.json().place).toMatchObject({ id: home.id, shared: true });

    // What's already going on there arrives in the feed, not as a push.
    const caughtUp = await store.alertsForUser(await userId(kid), 10);
    expect(caughtUp.map((a) => [a.eventId, a.matchedPlace, a.delivery])).toEqual([['before', 'Zuhause (Mama)', 'feed']]);

    // Everyone sees what is shared, by label and whose; nobody but Mama sees where.
    const seen = (await call('GET', '/v1/me/family', kid)).json().family;
    const mamaId = seen.members.find((m: any) => m.name === 'Mama').id;
    expect(seen.places).toEqual([{ id: home.id, label: 'Zuhause', memberId: mamaId }]);
    expect(JSON.stringify(seen)).not.toContain('52.503');
    expect((await call('GET', '/v1/me/places', kid)).json().places).toEqual([]);

    // A new event there: matching finds the kid through the family, far from her own location.
    await store.saveEvent(event('later'));
    const kidId = await userId(kid), mamaUserId = await userId(mama);
    const near = await store.usersNear(event('later'), 0, new Date());
    expect(near.find((n) => n.user.id === kidId)?.places).toMatchObject([{ label: 'Zuhause', sharedBy: 'Mama', shared: true }]);
    expect(near.find((n) => n.user.id === mamaUserId)?.places.map((p) => [p.label, p.sharedBy])).toEqual([['Zuhause', undefined]]);
    await pipeline.deliver((await store.getEvent('later'))!);
    expect((await store.alertsForUser(kidId, 10)).find((a) => a.eventId === 'later')?.matchedPlace).toBe('Zuhause (Mama)');
    expect((await store.alertsForUser(mamaUserId, 10)).find((a) => a.eventId === 'later')?.matchedPlace).toBe('Zuhause');

    // Stop sharing: the next event there no longer reaches the kid.
    expect((await call('PATCH', `/v1/me/places/${home.id}`, mama, { shared: false })).json().place.shared).toBe(false);
    await store.saveEvent(event('after'));
    await pipeline.deliver((await store.getEvent('after'))!);
    expect((await store.alertsForUser(kidId, 10)).map((a) => a.eventId).sort()).toEqual(['before', 'later']);
    expect((await call('GET', '/v1/me/family', kid)).json().family.places).toEqual([]);
  });

  it('sharing starts fresh with every family: leaving, being taken out or joining stops it', async () => {
    const { mama, kid, home } = await family2();
    const kidPlace = (await call('POST', '/v1/me/places', kid, { label: 'Schule', lat: 48.14, lon: 11.58 })).json().place;
    await call('PATCH', `/v1/me/places/${home.id}`, mama, { shared: true });
    await call('PATCH', `/v1/me/places/${kidPlace.id}`, kid, { shared: true });
    expect((await call('GET', '/v1/me/family', mama)).json().family.places.map((p: any) => p.label)).toEqual(['Schule', 'Zuhause']);
    expect((await store.familyPlaces(await userId(mama))).map((p) => [p.label, p.sharedBy])).toEqual([['Schule', 'Lena']]);

    const members = (await call('GET', '/v1/me/family', mama)).json().family.members;
    await call('DELETE', `/v1/me/family/members/${members[1].id}`, mama); // the kid is taken out
    expect((await call('GET', '/v1/me/places', kid)).json().places[0].shared).toBe(false);
    expect(await store.familyPlaces(await userId(kid))).toEqual([]);
    expect(await store.familyPlaces(await userId(mama))).toEqual([]);

    await call('DELETE', '/v1/me/family', mama); // Mama leaves
    expect((await call('GET', '/v1/me/places', mama)).json().places[0].shared).toBe(false);
    expect((await call('PATCH', `/v1/me/places/${home.id}`, mama, { shared: true })).json()).toEqual({ error: 'not_in_family' });
    expect((await call('PATCH', `/v1/me/places/${home.id}`, mama, { shared: false })).statusCode).toBe(200); // stopping always works

    // A place shared in one family isn't shared with the next one.
    await call('POST', '/v1/me/family', kid, { name: 'Lena' });
    await call('PATCH', `/v1/me/places/${kidPlace.id}`, kid, { shared: true });
    await call('DELETE', '/v1/me/family', kid);
    await call('POST', '/v1/me/family', kid, { name: 'Lena' });
    expect((await call('GET', '/v1/me/family', kid)).json().family.places).toEqual([]);
  });

  it('refuses junk on the share switch', async () => {
    const { mama, home } = await family2();
    expect((await call('PATCH', `/v1/me/places/${home.id}`, mama, { shared: 'yes' })).statusCode).toBe(400);
    expect((await call('PATCH', `/v1/me/places/${home.id}`, mama, { shared: true, label: 'x' })).statusCode).toBe(400);
    expect((await call('PATCH', `/v1/me/places/${home.id}`, mama, {})).statusCode).toBe(400);
    expect((await call('PATCH', '/v1/me/places/nope', mama, { shared: true })).json()).toEqual({ error: 'not_found' });
    expect((await call('PATCH', `/v1/me/places/${home.id}`, undefined, { shared: true })).statusCode).toBe(401);
  });

  it('never more than six, even when people join at the very same moment', async () => {
    const admin = await device();
    await call('POST', '/v1/me/family', admin, { name: 'Admin' });
    const familyId = (await store.familyMemberByUser(await userId(admin)))!.familyId;
    for (let i = 1; i < FAMILY_MAX - 1; i++) {
      await call('POST', '/v1/me/family/join', await device(), { code: await invite(admin), name: `P${i}` });
    }
    expect(await store.familyMembers(familyId)).toHaveLength(FAMILY_MAX - 1);
    const racers = await Promise.all(Array.from({ length: 4 }, async () => userId(await device())));
    const results = await Promise.all(racers.map((u, i) =>
      store.addFamilyMember({ id: crypto.randomUUID(), familyId, userId: u, name: `R${i}`, joinedAt: new Date().toISOString() }, FAMILY_MAX)));
    expect(results.filter((r) => r === 'added')).toHaveLength(1);
    expect(results.filter((r) => r === 'family_full')).toHaveLength(3);
    expect(await store.familyMembers(familyId)).toHaveLength(FAMILY_MAX);
    expect(await store.addFamilyMember({ id: crypto.randomUUID(), familyId: crypto.randomUUID(), userId: racers[results.indexOf('added')], name: 'x', joinedAt: new Date().toISOString() }, FAMILY_MAX)).toBe('already_in_family');
  });
});
