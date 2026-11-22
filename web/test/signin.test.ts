import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buttonsToShow, makeNonce, providerErrorKey, toHex } from '../lib/signin';
import { createApi } from '../lib/api';
import { APP_STRINGS } from '../lib/app-strings';

// Sign in with Apple / Google (2026-11-22): shared by the phone app and the web app.
test('nonce: random hex, and the hash the provider gets is SHA-256 of it (what the server checks)', async () => {
  const sha = async (s: string) => createHash('sha256').update(s).digest('hex');
  const n = await makeNonce((k) => Uint8Array.from({ length: k }, (_, i) => i * 17), sha);
  assert.equal(n.raw, toHex(Uint8Array.from({ length: 16 }, (_, i) => i * 17)));
  assert.equal(n.raw.length, 32);
  assert.equal(n.hashed, createHash('sha256').update(n.raw).digest('hex'));
  assert.equal(toHex(new Uint8Array([0, 15, 255])), '000fff');
});

test('buttons only where both the server and this client can do it; calm messages for each refusal', () => {
  assert.deepEqual(buttonsToShow({ email: true, apple: true, google: true }, { apple: true, google: false }), ['apple']);
  assert.deepEqual(buttonsToShow({ email: true, apple: false, google: true }, { apple: true, google: true }), ['google']);
  assert.deepEqual(buttonsToShow({ email: false, apple: false, google: false }, { apple: true, google: true }), []);
  assert.equal(providerErrorKey(503, 'provider_not_configured'), 'acc.err.providerOff');
  assert.equal(providerErrorKey(400, 'email_required'), 'acc.err.noEmail');
  assert.equal(providerErrorKey(409, 'account_conflict'), 'acc.err.conflict');
  assert.equal(providerErrorKey(400, 'invalid_token'), 'acc.err.provider');
  assert.equal(providerErrorKey(500, 'x'), 'acc.err.generic');
  for (const lang of ['de', 'en', 'ta'] as const) {
    for (const k of ['acc.or', 'acc.apple', 'acc.err.noEmail', 'acc.err.conflict', 'acc.err.provider', 'acc.err.providerOff'] as const) {
      assert.ok(APP_STRINGS[lang][k]?.length, `${lang} ${k}`);
    }
  }
});

test('API: providers is public; sign-in sends the identity token and the raw nonce', async () => {
  const calls: Array<{ url: string; auth: string | undefined; body: string | undefined }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).authorization, body: init.body as string | undefined });
    return new Response('{"email":true,"apple":false,"google":true}', { status: 200 });
  }) as unknown as typeof fetch;
  const api = createApi(f, () => 'tok', 'https://srv.test');
  assert.deepEqual(await api.authProviders(), { email: true, apple: false, google: true });
  await api.signInWith('google', 'eyJ.token.sig', 'raw-nonce');
  assert.deepEqual(calls, [
    { url: 'https://srv.test/v1/auth/providers', auth: undefined, body: undefined },
    { url: 'https://srv.test/v1/auth/google', auth: 'Bearer tok', body: '{"idToken":"eyJ.token.sig","nonce":"raw-nonce"}' },
  ]);
});

test('the phone app uses the same sign-in module', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');
  assert.equal(read('../app/src/lib/signin.ts'), read('lib/signin.ts'));
});
