import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants, { ExecutionEnvironment } from 'expo-constants';

// Crash reporting via Firebase Crashlytics (PRD 5.3, 13).
// - Only active in builds that include Firebase (app.config.ts sets extra.firebaseEnabled) and never in Expo Go.
// - Opt-in: native auto-collection is off (firebase.json); nothing is sent until the user enables it in Settings.
// - Reports carry no user id, location or alert content — only the error and a short context tag.

type CrashlyticsModule = typeof import('@react-native-firebase/crashlytics');
type Crashlytics = import('@react-native-firebase/crashlytics').Crashlytics;

const OPT_IN_KEY = 'heyokay.crashReports';

let mod: CrashlyticsModule | null = null;
let instance: Crashlytics | null | undefined;

function crashlytics(): Crashlytics | null {
  if (instance !== undefined) return instance;
  instance = null;
  const built = Constants.expoConfig?.extra?.firebaseEnabled === true;
  if (!built || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return null;
  try {
    mod = require('@react-native-firebase/crashlytics') as CrashlyticsModule;
    instance = mod.getCrashlytics(); // also installs the global JS error + unhandled rejection handlers
  } catch {
    mod = null;
    instance = null; // native module missing (e.g. a build without Firebase): stay a no-op
  }
  return instance;
}

/** True if this build can send crash reports at all (used to show the Settings toggle). */
export function crashReportingAvailable(): boolean {
  return crashlytics() !== null;
}

export async function getCrashReportsOptIn(): Promise<boolean> {
  return (await AsyncStorage.getItem(OPT_IN_KEY)) === '1';
}

export async function setCrashReportsOptIn(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(OPT_IN_KEY, enabled ? '1' : '0');
  const c = crashlytics();
  if (!c || !mod) return;
  try {
    await mod.setCrashlyticsCollectionEnabled(c, enabled);
    if (!enabled) await mod.deleteUnsentReports(c);
  } catch {
    // Reporting must never break the app.
  }
}

/** Call once at startup: applies the stored opt-in to the native SDK. */
export async function initCrashReporting(): Promise<void> {
  if (!crashlytics()) return;
  await setCrashReportsOptIn(await getCrashReportsOptIn());
}

/** Report a handled JS error (e.g. from an error boundary). No-op without Firebase or opt-in. */
export function reportError(error: unknown, context?: string): void {
  const err = error instanceof Error ? error : new Error(String(error));
  if (__DEV__) console.error(context ? `[${context}]` : '', err);
  const c = crashlytics();
  if (!c || !mod) return;
  try {
    if (context) mod.log(c, context);
    mod.recordError(c, err, context);
  } catch {
    // ignore
  }
}
