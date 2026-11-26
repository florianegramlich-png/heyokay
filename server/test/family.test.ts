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
import { CODE_ALPHABET, FAMILY_MAX, inviteCodeHash, makeInviteCode, normalizeInviteCode } from '../src/family.js';

// PRD 6.1 #8, 3.3 #4: family groups with invite codes (part 1a). Places, never people's locations.

describe('invite codes', () => {
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
  let store: Store, mailer: MemoryMailer, app: ReturnType<typeof buildApi>;
  beforeEach(async () => {
    store = await backend.make();
    mailer = new MemoryMailer();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
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
});
