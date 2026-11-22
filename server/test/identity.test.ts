import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { MemoryMailer } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { IdentityError, IdentityVerifier, PROVIDERS, nonceHash, nonceMatches, parseClientIds } from '../src/identity.js';

// A stand-in for Apple's / Google's key server: real RSA keys, a JWKS endpoint, signed tokens.
function keyServer() {
  const keys = new Map<string, KeyObject>();
  const pub = new Map<string, object>();
  const addKey = (kid: string) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keys.set(kid, privateKey);
    pub.set(kid, { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' });
  };
  let fetches = 0;
  let down = false;
  const fetch = async (_url: string) => {
    fetches++;
    if (down) return new Response('nope', { status: 503 });
    return new Response(JSON.stringify({ keys: [...pub.values()] }), { headers: { 'cache-control': 'public, max-age=21600' } });
  };
  const token = (claims: Record<string, unknown>, kid = [...keys.keys()][0], alg = 'RS256') => {
    const h = Buffer.from(JSON.stringify({ alg, kid })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), keys.get(kid)!).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  return {
    addKey, fetch, token,
    dropKey: (kid: string) => pub.delete(kid),
    get fetches() { return fetches; },
    set down(v: boolean) { down = v; },
  };
}

const T0 = new Date('2026-11-21T10:00:00Z');
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
/** The raw nonce the app keeps; Apple/Google get its SHA-256. */
const RAW = 'n0nce-3f9a1c7e5b2d4a68';
const appleClaims = (over: Record<string, unknown> = {}) => ({
  nonce: nonceHash(RAW),
  iss: 'https://appleid.apple.com', aud: 'app.heyokay', sub: '001234.abcd', iat: sec(T0) - 10, exp: sec(T0) + 600,
  email: 'flori@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true', ...over,
});

describe('identity token check', () => {
  let ks: ReturnType<typeof keyServer>, clock: Date, v: IdentityVerifier;
  beforeEach(() => {
    ks = keyServer(); ks.addKey('k1');
    clock = T0;
    v = new IdentityVerifier('apple', { audiences: ['app.heyokay', 'app.heyokay.web'], fetch: ks.fetch, now: () => clock });
  });
  const rejects = async (token: string, code: string) => {
    const err = await v.verify(token).catch((e) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect(err.code).toBe(code);
  };

  it('accepts a good token and returns only sub and email (Apple sends email_verified as a string)', async () => {
    expect(await v.verify(ks.token(appleClaims()))).toEqual({ sub: '001234.abcd', email: 'flori@privaterelay.appleid.com', emailVerified: true, nonce: nonceHash(RAW) });
    expect(await v.verify(ks.token(appleClaims({ aud: ['other', 'app.heyokay.web'], email_verified: false })))).toMatchObject({ emailVerified: false });
    expect(await v.verify(ks.token(appleClaims({ email: undefined })))).toEqual({ sub: '001234.abcd', email: null, emailVerified: false, nonce: nonceHash(RAW) });
    expect(ks.fetches).toBe(1); // keys cached
  });

  it('rejects wrong issuer, audience, expiry, signature, algorithm and garbage', async () => {
    await rejects(ks.token(appleClaims({ iss: 'https://accounts.google.com' })), 'invalid_token');
    await rejects(ks.token(appleClaims({ aud: 'someone.else' })), 'invalid_token');
    await rejects(ks.token(appleClaims({ exp: sec(T0) - 61 })), 'invalid_token');
    expect(await v.verify(ks.token(appleClaims({ exp: sec(T0) - 30 })))).toBeTruthy(); // within clock slack
    await rejects(ks.token(appleClaims({ iat: sec(T0) + 3600 })), 'invalid_token');
    await rejects(ks.token(appleClaims({ sub: '' })), 'invalid_token');
    const good = ks.token(appleClaims());
    const [h, , s] = good.split('.');
    const forged = Buffer.from(JSON.stringify(appleClaims({ sub: 'someone-else' }))).toString('base64url');
    await rejects(`${h}.${forged}.${s}`, 'invalid_token');
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    await rejects(`${none}.${good.split('.')[1]}.`, 'invalid_token');
    await rejects('not-a-jwt', 'invalid_token');
    await rejects('a.b.c', 'invalid_token');
  });

  it('follows key rotation, but fetches at most once a minute', async () => {
    await v.verify(ks.token(appleClaims()));
    ks.addKey('k2');
    await rejects(ks.token(appleClaims(), 'k2'), 'invalid_token'); // just fetched: no refetch yet
    expect(ks.fetches).toBe(1);
    clock = new Date(T0.getTime() + 61_000);
    expect(await v.verify(ks.token(appleClaims(), 'k2'))).toBeTruthy();
    expect(ks.fetches).toBe(2);
    const unknownKid = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'unknown' })).toString('base64url');
    await rejects(ks.token(appleClaims(), 'k2').replace(/^[^.]+/, unknownKid), 'invalid_token');
    expect(ks.fetches).toBe(2); // within the minute: no fetch for made-up key ids
  });

  it('a key server that is down: cached keys keep working; without keys it is "unavailable", not "invalid"', async () => {
    await v.verify(ks.token(appleClaims()));
    ks.down = true;
    clock = new Date(T0.getTime() + 7 * 3600_000); // cache (6 h) ran out
    expect(await v.verify(ks.token(appleClaims({ exp: sec(clock) + 600, iat: sec(clock) })))).toBeTruthy();

    const fresh = new IdentityVerifier('google', { audiences: ['x'], fetch: ks.fetch, now: () => clock });
    const err = await fresh.verify(ks.token({ ...appleClaims(), iss: 'accounts.google.com', aud: 'x' })).catch((e) => e);
    expect(err.code).toBe('provider_unavailable');
  });

  it('settings and provider defaults', () => {
    expect(parseClientIds(' app.heyokay, 123-abc.apps.googleusercontent.com ,')).toEqual(['app.heyokay', '123-abc.apps.googleusercontent.com']);
    expect(parseClientIds('')).toBeNull();
    expect(parseClientIds(undefined)).toBeNull();
    expect(loadConfig({ APPLE_CLIENT_IDS: 'app.heyokay' })).toMatchObject({ appleClientIds: ['app.heyokay'], googleClientIds: null });
    expect(PROVIDERS.google.issuers).toContain('accounts.google.com');
    expect(() => new IdentityVerifier('apple', { audiences: [] })).toThrow();
  });
});

describe.each(storeBackends())('sign in with Apple / Google ($name)', (backend) => {
  let store: Store, mailer: MemoryMailer, app: ReturnType<typeof buildApi>, apple: ReturnType<typeof keyServer>, google: ReturnType<typeof keyServer>;
  beforeEach(async () => {
    store = await backend.make();
    mailer = new MemoryMailer();
    apple = keyServer(); apple.addKey('a1');
    google = keyServer(); google.addKey('g1');
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const now = () => T0;
    app = buildApi({
      store, pipeline, adminToken: 'a', runIngest: async () => ({}), mailer, errorSink: () => {},
      identity: {
        apple: new IdentityVerifier('apple', { audiences: ['app.heyokay'], fetch: apple.fetch, now }),
        google: new IdentityVerifier('google', { audiences: ['web-client.apps.googleusercontent.com'], fetch: google.fetch, now }),
      },
    });
  });
  afterEach(async () => { await store.close(); });

  const call = (method: string, url: string, token?: string, payload?: unknown) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const device = async (prefs: object = {}) => (await call('POST', '/v1/devices', undefined, { prefs })).json().token as string;
  const googleToken = (over: Record<string, unknown> = {}) => google.token({
    iss: 'https://accounts.google.com', aud: 'web-client.apps.googleusercontent.com', sub: '1098765', iat: sec(T0), exp: sec(T0) + 3600,
    email: 'Flori@Example.org', email_verified: true, nonce: nonceHash(RAW), ...over,
  });

  it('Apple: the first sign-in makes an account; a new phone with the same Apple ID gets its places back', async () => {
    const phoneA = await device({ dailyLimit: 4 });
    await call('POST', '/v1/me/places', phoneA, { label: 'Mama', lat: 52.51, lon: 13.45 });
    const r = await call('POST', '/v1/auth/apple', phoneA, { idToken: apple.token(appleClaims()), nonce: RAW });
    expect(r.statusCode).toBe(200);
    expect(r.json().account).toEqual({ email: 'flori@privaterelay.appleid.com' });

    const phoneB = await device();
    // Apple may leave out the email on later sign-ins: the linked id is enough.
    const r2 = await call('POST', '/v1/auth/apple', phoneB, { idToken: apple.token(appleClaims({ email: undefined, email_verified: undefined })), nonce: RAW });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().prefs.dailyLimit).toBe(4);
    expect(r2.json().places.map((p: any) => p.label)).toEqual(['Mama']);
    expect((await call('GET', '/v1/me', phoneB)).json().userId).toBe((await call('GET', '/v1/me', phoneA)).json().userId);
  });

  it('Google with a verified email joins the account made with an email code', async () => {
    const phone = await device();
    await call('POST', '/v1/auth/email/start', phone, { email: 'flori@example.org' });
    const code = mailer.sent.at(-1)!.text.match(/\b(\d{6})\b/)![1];
    await call('POST', '/v1/auth/email/verify', phone, { email: 'flori@example.org', code });
    await call('POST', '/v1/me/places', phone, { label: 'Kita', lat: 52.52, lon: 13.41 });

    const browser = await device();
    const r = await call('POST', '/v1/auth/google', browser, { idToken: googleToken(), nonce: RAW });
    expect(r.statusCode).toBe(200);
    expect(r.json().account).toEqual({ email: 'flori@example.org' });
    expect(r.json().places.map((p: any) => p.label)).toEqual(['Kita']);
    expect((await call('GET', '/v1/me', browser)).json().userId).toBe((await call('GET', '/v1/me', phone)).json().userId);
  });

  it('never links on an unverified email, never links a second Google id to one account', async () => {
    const t = await device();
    const unverified = await call('POST', '/v1/auth/google', t, { idToken: googleToken({ email_verified: false }), nonce: RAW });
    expect(unverified.statusCode).toBe(400);
    expect(unverified.json().error).toBe('email_required');
    expect((await call('GET', '/v1/me', t)).json().account).toBeNull();

    expect((await call('POST', '/v1/auth/google', t, { idToken: googleToken(), nonce: RAW })).statusCode).toBe(200);
    const other = await device();
    const r = await call('POST', '/v1/auth/google', other, { idToken: googleToken({ sub: '2222222' }), nonce: RAW });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('account_conflict');
  });

  it('bad tokens, missing settings, and no device token', async () => {
    const t = await device();
    const bad = await call('POST', '/v1/auth/apple', t, { idToken: apple.token(appleClaims({ aud: 'web-client.apps.googleusercontent.com' })), nonce: RAW });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_token');
    // A Google token sent to the Apple route fails the signature (different key server).
    expect((await call('POST', '/v1/auth/apple', t, { idToken: googleToken(), nonce: RAW })).statusCode).toBe(400);
    expect((await call('POST', '/v1/auth/apple', t, { idToken: 'short', nonce: RAW })).statusCode).toBe(400);
    expect((await call('POST', '/v1/auth/apple', undefined, { idToken: apple.token(appleClaims()), nonce: RAW })).statusCode).toBe(401);

    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const bare = buildApi({ store, pipeline, adminToken: 'a', runIngest: async () => ({}), errorSink: () => {} });
    const r = await bare.inject({ method: 'POST', url: '/v1/auth/google', payload: { idToken: googleToken(), nonce: RAW }, headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('provider_not_configured');
  });

  it('the nonce must match: a token replayed without the app\'s raw nonce is refused', async () => {
    const t = await device();
    const token = apple.token(appleClaims());
    expect((await call('POST', '/v1/auth/apple', t, { idToken: token, nonce: 'someone-elses-nonce-123' })).json()).toEqual({ error: 'invalid_token' });
    expect((await call('POST', '/v1/auth/apple', t, { idToken: token })).statusCode).toBe(400); // nonce is required
    expect((await call('POST', '/v1/auth/apple', t, { idToken: apple.token(appleClaims({ nonce: undefined })), nonce: RAW })).statusCode).toBe(400);
    expect((await call('GET', '/v1/me', t)).json().account).toBeNull();
    expect(nonceMatches({ nonce: nonceHash(RAW) }, RAW)).toBe(true);
    expect(nonceMatches({ nonce: RAW }, RAW)).toBe(false); // the raw value itself is not accepted
  });

  it('tells apps which sign-in methods are switched on', async () => {
    expect((await call('GET', '/v1/auth/providers')).json()).toEqual({ email: true, apple: true, google: true });
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const bare = buildApi({ store, pipeline, adminToken: 'a', runIngest: async () => ({}), errorSink: () => {} });
    expect((await bare.inject({ method: 'GET', url: '/v1/auth/providers' })).json()).toEqual({ email: false, apple: false, google: false });
  });

  it('deleting the account (GDPR) also forgets the Apple link', async () => {
    const t = await device();
    await call('POST', '/v1/me/places', t, { label: 'Mama', lat: 52.51, lon: 13.45 });
    const first = (await call('POST', '/v1/auth/apple', t, { idToken: apple.token(appleClaims()), nonce: RAW })).json();
    expect((await call('DELETE', '/v1/me', t)).statusCode).toBe(200);
    expect(await store.accountByIdentity('apple', '001234.abcd')).toBeNull();

    const t2 = await device();
    const again = (await call('POST', '/v1/auth/apple', t2, { idToken: apple.token(appleClaims()), nonce: RAW })).json();
    expect(again.userId).not.toBe(first.userId);
    expect(again.places).toEqual([]);
  });
});
