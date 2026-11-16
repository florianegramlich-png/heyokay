/// <reference types="node" />
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// Firebase (Crashlytics) is switched on only when both config files from the Firebase console
// are present in ./firebase. Until the Firebase project exists, builds work without it and
// the app's crash reporter is a no-op. See firebase/README.md.
const IOS_FILE = './firebase/GoogleService-Info.plist';
const ANDROID_FILE = './firebase/google-services.json';

export function firebaseFilesPresent(root: string): boolean {
  return existsSync(join(root, IOS_FILE)) && existsSync(join(root, ANDROID_FILE));
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const firebaseEnabled = firebaseFilesPresent(process.cwd());
  const base = config as ExpoConfig;
  if (!firebaseEnabled) {
    return { ...base, extra: { ...base.extra, firebaseEnabled: false } };
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
};
