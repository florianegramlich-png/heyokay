import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { googleIdToken, googleIdsFromEnv, reversedClientId, type GoogleModule, type GoogleResponse } from '../src/lib/google-signin.ts';
import { withGoogle } from '../app.config.ts';

// PRD 5.3: Sign in with Google on the phone (react-native-nitro-google-signin), off until the client ids are set.

const WEB = '111-web.apps.googleusercontent.com';
const IOS = '111-ios.apps.googleusercontent.com';
const IDS = { webClientId: WEB, iosClientId: IOS };

function fake(answers: Array<GoogleResponse | Error>, opts: { playServices?: Error } = {}) {
  const calls: string[] = [];
  const configured: unknown[] = [];
  const next = async (name: string) => {
    calls.push(name);
    const a = answers.shift();
    if (!a) throw new Error('no answer left');
    if (a instanceof Error) throw a;
    return a;
  };
  const mod: GoogleModule = {
    configure: (p) => { calls.push('configure'); configured.push(p); },
    checkPlayServices: async () => { calls.push('checkPlayServices'); if (opts.playServices) throw opts.playServices; },
    signIn: () => next('signIn'),
    createAccount: () => next('createAccount'),
    presentExplicitSignIn: () => next('presentExplicitSignIn'),
  };
  return { mod, calls, configured };
}
const ok = (idToken: string): GoogleResponse => ({ type: 'success', data: { idToken } });
const none: GoogleResponse = { type: 'noSavedCredentialFound', data: null };
const coded = (code: string) => Object.assign(new Error(code), { code });

test('reversed client id is the iOS URL scheme', () => {
  assert.equal(reversedClientId(IOS), 'com.googleusercontent.apps.111-ios');
});

test('Google is on only with both client ids in the expected form', () => {
  assert.deepEqual(googleIdsFromEnv({ GOOGLE_WEB_CLIENT_ID: WEB, GOOGLE_IOS_CLIENT_ID: ` ${IOS} ` }), IDS);
  assert.equal(googleIdsFromEnv({}), null);
  assert.equal(googleIdsFromEnv({ GOOGLE_WEB_CLIENT_ID: WEB }), null);
  assert.equal(googleIdsFromEnv({ GOOGLE_WEB_CLIENT_ID: WEB, GOOGLE_IOS_CLIENT_ID: 'placeholder' }), null);
});

test('a saved account signs in straight away, with the hashed nonce configured first', async () => {
  const f = fake([ok('tok-1')]);
  assert.deepEqual(await googleIdToken(f.mod, IDS, 'abc123', false), { kind: 'token', idToken: 'tok-1' });
  assert.deepEqual(f.calls, ['configure', 'signIn']);
  assert.deepEqual(f.configured[0], { webClientId: WEB, iosClientId: IOS, nonce: 'abc123', scopes: ['email'], autoSelectOnSignIn: false });
});

test('no saved account: any account on the phone, then Google\'s own screen', async () => {
  const f = fake([none, none, ok('tok-2')]);
  assert.deepEqual(await googleIdToken(f.mod, IDS, 'n', true), { kind: 'token', idToken: 'tok-2' });
  assert.deepEqual(f.calls, ['configure', 'checkPlayServices', 'signIn', 'createAccount', 'presentExplicitSignIn']);
});

test('closing the sheet is quiet; other problems fail', async () => {
  assert.deepEqual(await googleIdToken(fake([{ type: 'cancelled', data: null }]).mod, IDS, 'n', false), { kind: 'cancelled' });
  assert.deepEqual(await googleIdToken(fake([coded('SIGN_IN_CANCELLED')]).mod, IDS, 'n', false), { kind: 'cancelled' });
  assert.deepEqual(await googleIdToken(fake([coded('NETWORK_ERROR')]).mod, IDS, 'n', false), { kind: 'failed' });
  assert.deepEqual(await googleIdToken(fake([none, none, none]).mod, IDS, 'n', false), { kind: 'failed' });
  assert.deepEqual(await googleIdToken(fake([{ type: 'success', data: null }]).mod, IDS, 'n', false), { kind: 'failed' });
  const noPlay = fake([], { playServices: coded('PLAY_SERVICES_NOT_AVAILABLE') });
  assert.deepEqual(await googleIdToken(noPlay.mod, IDS, 'n', true), { kind: 'failed' });
  assert.deepEqual(noPlay.calls, ['configure', 'checkPlayServices']);
});

test('app config adds the plugin and the ids only when both are set', () => {
  const base = { name: 'Hey-Okay', slug: 'heyokay', plugins: ['expo-router'], extra: { apiUrl: 'x' } };
  assert.deepEqual(withGoogle(base, {}), base);
  const on = withGoogle(base, { GOOGLE_WEB_CLIENT_ID: WEB, GOOGLE_IOS_CLIENT_ID: IOS });
  assert.deepEqual(on.plugins, ['expo-router', ['react-native-nitro-google-signin', { iosUrlScheme: 'com.googleusercontent.apps.111-ios' }]]);
  assert.deepEqual(on.extra, { apiUrl: 'x', google: IDS });
});

test('native code is linked only when both ids are set', () => {
  const require = createRequire(import.meta.url);
  const path = require.resolve('../react-native.config.js');
  const load = (env: Record<string, string | undefined>) => {
    const saved = { web: process.env.GOOGLE_WEB_CLIENT_ID, ios: process.env.GOOGLE_IOS_CLIENT_ID };
    const set = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    set('GOOGLE_WEB_CLIENT_ID', env.GOOGLE_WEB_CLIENT_ID); set('GOOGLE_IOS_CLIENT_ID', env.GOOGLE_IOS_CLIENT_ID);
    try { delete require.cache[path]; return require(path).dependencies as Record<string, unknown>; }
    finally { set('GOOGLE_WEB_CLIENT_ID', saved.web); set('GOOGLE_IOS_CLIENT_ID', saved.ios); delete require.cache[path]; }
  };
  const unlinked = { platforms: { ios: null, android: null } };
  const off = load({});
  assert.deepEqual(off['react-native-nitro-google-signin'], unlinked);
  assert.deepEqual(off['react-native-nitro-modules'], unlinked);
  const on = load({ GOOGLE_WEB_CLIENT_ID: WEB, GOOGLE_IOS_CLIENT_ID: IOS });
  assert.equal(on['react-native-nitro-google-signin'], undefined);
  assert.equal(on['react-native-nitro-modules'], undefined);
});
