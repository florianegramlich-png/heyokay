/// <reference types="node" />
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import { googleIdsFromEnv, reversedClientId } from './src/lib/google-signin.ts';

// Firebase (Crashlytics) is switched on only when both config files from the Firebase console
// are present in ./firebase. Until the Firebase project exists, builds work without it and
// the app's crash reporter is a no-op. See firebase/README.md.
const IOS_FILE = './firebase/GoogleService-Info.plist';
const ANDROID_FILE = './firebase/google-services.json';

export function firebaseFilesPresent(root: string): boolean {
  return existsSync(join(root, IOS_FILE)) && existsSync(join(root, ANDROID_FILE));
}

// Sign in with Google on the phone: on only when GOOGLE_WEB_CLIENT_ID and GOOGLE_IOS_CLIENT_ID are set
// for the build (EAS environment variables). Then the plugin adds the iOS URL scheme and the app gets
// the ids in extra.google; react-native.config.js links the native code under the same rule.
export function withGoogle(base: ExpoConfig, env: Record<string, string | undefined>): ExpoConfig {
  const ids = googleIdsFromEnv(env);
  if (!ids) return base;
  return {
    ...base,
    plugins: [...(base.plugins ?? []), ['react-native-nitro-google-signin', { iosUrlScheme: reversedClientId(ids.iosClientId) }]],
    extra: { ...base.extra, google: ids },
  };
}

export default ({ config }: ConfigContext): ExpoConfig => withGoogle(withFirebase(config as ExpoConfig, process.cwd()), process.env);

/**
 * Push notifications on Android go through Firebase Cloud Messaging, so an Android build needs
 * google-services.json even when Crashlytics isn't set up. With only that file, Android gets it
 * for push; Crashlytics (and its native code) still waits for both files.
 */
export function withFirebase(base: ExpoConfig, root: string): ExpoConfig {
  const firebaseEnabled = firebaseFilesPresent(root);
  if (!firebaseEnabled) {
    const androidPush = existsSync(join(root, ANDROID_FILE));
    return {
      ...base,
      ...(androidPush ? { android: { ...base.android, googleServicesFile: ANDROID_FILE } } : {}),
      extra: { ...base.extra, firebaseEnabled: false },
    };
  }
  return {
    ...base,
    ios: { ...base.ios, googleServicesFile: IOS_FILE },
    android: { ...base.android, googleServicesFile: ANDROID_FILE },
    plugins: [
      ...(base.plugins ?? []),
      '@react-native-firebase/app',
      '@react-native-firebase/crashlytics',
      // Firebase Apple SDK is SPM-only; RN Firebase requires dynamic frameworks on iOS.
      ['expo-build-properties', { ios: { useFrameworks: 'dynamic' } }],
    ],
    extra: { ...base.extra, firebaseEnabled: true },
  };
}
