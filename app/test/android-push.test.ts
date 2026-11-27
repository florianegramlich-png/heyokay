import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExpoConfig } from 'expo/config';
import { withFirebase } from '../app.config.ts';

// Android push needs google-services.json (FCM) even without Crashlytics.
const base: ExpoConfig = { name: 'Hey-Okay', slug: 'heyokay', android: { package: 'de.heyokay.app' }, plugins: ['expo-router'] };
const dir = (files: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'hok-app-'));
  mkdirSync(join(d, 'firebase'));
  for (const f of files) writeFileSync(join(d, 'firebase', f), '{}');
  return d;
};

test('no Firebase files: nothing added', () => {
  const c = withFirebase(base, dir([]));
  assert.equal(c.android?.googleServicesFile, undefined);
  assert.equal((c.extra as { firebaseEnabled: boolean }).firebaseEnabled, false);
});

test('only google-services.json: Android gets it for push, Crashlytics stays off', () => {
  const c = withFirebase(base, dir(['google-services.json']));
  assert.equal(c.android?.googleServicesFile, './firebase/google-services.json');
  assert.equal(c.android?.package, 'de.heyokay.app');
  assert.equal(c.ios?.googleServicesFile, undefined);
  assert.deepEqual(c.plugins, ['expo-router']);
  assert.equal((c.extra as { firebaseEnabled: boolean }).firebaseEnabled, false);
});

test('both files: Firebase and Crashlytics on both platforms', () => {
  const c = withFirebase(base, dir(['google-services.json', 'GoogleService-Info.plist']));
  assert.equal(c.ios?.googleServicesFile, './firebase/GoogleService-Info.plist');
  assert.ok(c.plugins?.includes('@react-native-firebase/crashlytics'));
  assert.equal((c.extra as { firebaseEnabled: boolean }).firebaseEnabled, true);
});
