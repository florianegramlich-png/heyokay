import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { MemoryMailer, checkEmailCode, startEmailSignIn } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

describe.each(storeBackends())('email sign-in ($name)', (backend) => {
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
  const device = async (prefs: object = {}) => (await call('POST', '/v1/devices', undefined, { prefs })).json().token as string;
  const lastCode = () => mailer.sent.at(-1)!.text.match(/\b(\d{6})\b/)![1];
  async function signInWith(token: string, email: string) {
    expect((await call('POST', '/v1/auth/email/start', token, { email })).statusCode).toBe(202);
    return call('POST', '/v1/auth/email/verify', token, { email, code: lastCode() });
  }

  it('sends a code in the device language and signs in; the code works once', async () => {
    const t = await device({ language: 'de' });
    expect((await call('POST', '/v1/auth/email/start', t, { email: ' Flori@Example.org ' })).statusCode).toBe(202);
    expect(mailer.sent[0]).toMatchObject({ to: 'flori@example.org' });
    expect(mailer.sent[0].subject).toMatch(/^\d{6} ist dein Hey-Okay-Code$/);
    const code = lastCode();
    expect((await call('POST', '/v1/auth/email/verify', t, { email: 'flori@example.org', code: code === '000000' ? '111111' : '000000' })).statusCode).toBe(400);
    const ok = await call('POST', '/v1/auth/email/verify', t, { email: 'FLORI@example.org', code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().account).toEqual({ email: 'flori@example.org' });
    expect((await call('GET', '/v1/me', t)).json().account).toEqual({ email: 'flori@example.org' });
    expect((await call('POST', '/v1/auth/email/verify', t, { email: 'flori@example.org', code })).statusCode).toBe(400); // used
  });

  it('a new phone signing in gets the account back: places and settings, merged with its own places', async () => {
    const phoneA = await device({ dailyLimit: 5 });
    await call('POST', '/v1/me/places', phoneA, { label: 'Mama', lat: 52.51, lon: 13.45 });
    expect((await signInWith(phoneA, 'flori@example.org')).statusCode).toBe(200);

    const phoneB = await device();
    await call('POST', '/v1/me/places', phoneB, { label: 'Kita', lat: 52.52, lon: 13.41 });
    await call('POST', '/v1/me/places', phoneB, { label: 'Mama', lat: 52.51, lon: 13.45 }); // same place, not duplicated
    const r = await signInWith(phoneB, 'flori@example.org');
    expect(r.json().prefs.dailyLimit).toBe(5);
    expect(r.json().places.map((p: any) => p.label).sort()).toEqual(['Kita', 'Mama']);
    const a = (await call('GET', '/v1/me', phoneA)).json();
    const b = (await call('GET', '/v1/me', phoneB)).json();
    expect(a.userId).toBe(b.userId);
    expect(a.places).toHaveLength(2);
  });

  it('signing out gives the device a fresh anonymous identity; the account keeps its data', async () => {
    const phoneA = await device();
    await call('POST', '/v1/me/places', phoneA, { label: 'Mama', lat: 52.51, lon: 13.45 });
    await signInWith(phoneA, 'flori@example.org');
    const phoneB = await device();
    await signInWith(phoneB, 'flori@example.org');

    const out = await call('POST', '/v1/auth/signout', phoneB);
    expect(out.statusCode).toBe(200);
    const fresh = out.json().token as string;
    expect((await call('GET', '/v1/me', phoneB)).statusCode).toBe(401); // old token is gone
    const me = (await call('GET', '/v1/me', fresh)).json();
    expect(me).toMatchObject({ account: null, places: [] });
    expect((await call('GET', '/v1/me', phoneA)).json().places).toHaveLength(1);
    expect((await call('POST', '/v1/auth/signout', fresh)).statusCode).toBe(400); // not signed in
  });

  it('switching to another email starts a new account; the old one stays', async () => {
    const t = await device();
    await call('POST', '/v1/me/places', t, { label: 'Mama', lat: 52.51, lon: 13.45 });
    await signInWith(t, 'one@example.org');
    const r = await signInWith(t, 'two@example.org');
    expect(r.json()).toMatchObject({ account: { email: 'two@example.org' }, places: [] });
    const other = await device();
    expect((await signInWith(other, 'one@example.org')).json().places).toHaveLength(1);
  });

  it('GDPR delete removes the account and signs out every device', async () => {
    const phoneA = await device();
    await signInWith(phoneA, 'flori@example.org');
    const phoneB = await device();
    await signInWith(phoneB, 'flori@example.org');
    expect((await call('DELETE', '/v1/me', phoneA)).statusCode).toBe(200);
    expect((await call('GET', '/v1/me', phoneB)).statusCode).toBe(401);
    const again = await device();
    expect((await signInWith(again, 'flori@example.org')).json()).toMatchObject({ places: [], account: { email: 'flori@example.org' } });
    expect(await store.accountByEmail('flori@example.org')).not.toBeNull();
  });

  it('limits: wrong codes, expiry, sends per hour; same answer for unknown addresses', async () => {
    const t = await device();
    const now = new Date();
    await startEmailSignIn(store, mailer, 'x@example.org', 'en', now);
    const code = lastCode();
    for (let i = 0; i < 5; i++) expect(await checkEmailCode(store, 'x@example.org', code === '123456' ? '654321' : '123456', now)).toBe(false);
    expect(await checkEmailCode(store, 'x@example.org', code, now)).toBe(false); // locked after 5 wrong tries

    await startEmailSignIn(store, mailer, 'y@example.org', 'en', now);
    expect(await checkEmailCode(store, 'y@example.org', lastCode(), new Date(now.getTime() + 16 * 60_000))).toBe(false); // expired

    for (let i = 0; i < 3; i++) await call('POST', '/v1/auth/email/start', t, { email: 'x@example.org' }); // 2..4 + the one above
    expect((await call('POST', '/v1/auth/email/start', t, { email: 'x@example.org' })).statusCode).toBe(202); // 5th
    expect((await call('POST', '/v1/auth/email/start', t, { email: 'x@example.org' })).statusCode).toBe(429);
    expect((await call('POST', '/v1/auth/email/start', t, { email: 'not-an-email' })).statusCode).toBe(400);
    expect(mailer.sent.every((m) => !m.text.includes('Konto') && !m.text.includes('account'))).toBe(true); // no "you have an account"
  });

  it('without a mail provider, email sign-in reports it is not configured', async () => {
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const bare = buildApi({ store, pipeline, adminToken: 'a', runIngest: async () => ({}), errorSink: () => {} });
    const t = (await bare.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json().token;
    const r = await bare.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'a@b.de' }, headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'email_not_configured' });
  });
});
