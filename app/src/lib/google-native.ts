import Constants, { ExecutionEnvironment } from 'expo-constants';
import type { GoogleIds, GoogleModule } from './google-signin';

/**
 * The native Google sign-in module, or null when this build has none: the client ids weren't set
 * at build time (then react-native.config.js leaves the native code out), or this is Expo Go.
 * Same pattern as crash.ts for Firebase.
 */
let cached: { mod: GoogleModule; ids: GoogleIds } | null | undefined;

export function googleNative(): { mod: GoogleModule; ids: GoogleIds } | null {
  if (cached !== undefined) return cached;
  cached = null;
  const ids = Constants.expoConfig?.extra?.google as GoogleIds | undefined;
  if (!ids?.webClientId || !ids?.iosClientId || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return null;
  try {
    const lib = require('react-native-nitro-google-signin') as { GoogleOneTapSignIn: GoogleModule };
    cached = { mod: lib.GoogleOneTapSignIn, ids };
  } catch {
    cached = null; // native module missing: no Google button
  }
  return cached;
}
