import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';
import { getLanguage, translate } from './i18n';

export const LOCATION_TASK = 'heyokay-location';

/**
 * Background task: send the newest point to the server. The server keeps only the latest location
 * (no history) and immediately matches it against active events.
 * Must be defined at module scope, so this file is imported from the root layout.
 */
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const last = data.locations[data.locations.length - 1];
  try {
    await api.sendLocation(round(last.coords.latitude), round(last.coords.longitude));
  } catch {
    // Offline or not registered yet; the next update will retry.
  }
});

/** ~100 m precision is enough for area alerts and avoids sending exact positions. */
const round = (v: number) => Math.round(v * 1000) / 1000;

export type LocationAccess = 'always' | 'foreground' | 'denied';

/** PRD 5.3: ask for foreground first, explain, then ask for "always". */
export async function requestForeground(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

export async function requestBackground(): Promise<boolean> {
  const { status } = await Location.requestBackgroundPermissionsAsync();
  return status === 'granted';
}

export async function locationAccess(): Promise<LocationAccess> {
  const fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'denied';
  const bg = await Location.getBackgroundPermissionsAsync();
  return bg.status === 'granted' ? 'always' : 'foreground';
}

/** Significant-change style updates: every ~300 m or 15 min, battery-friendly. */
export async function startBackgroundUpdates() {
  if ((await locationAccess()) !== 'always') return false;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return true;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 300,
    deferredUpdatesInterval: 15 * 60_000,
    pausesUpdatesAutomatically: true,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: translate(getLanguage(), 'fgs.title'),
      notificationBody: translate(getLanguage(), 'fgs.body'),
      notificationColor: '#0F766E',
    },
  });
  return true;
}

export async function stopBackgroundUpdates() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}

/** One-off sync while the app is open (also covers "foreground only" users). */
export async function syncNow(firstSync = false) {
  if ((await locationAccess()) === 'denied') return null;
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return api.sendLocation(round(pos.coords.latitude), round(pos.coords.longitude), firstSync);
}

/** For "add a saved place": turn an address into coordinates with the OS geocoder. */
export async function geocode(address: string) {
  const [hit] = await Location.geocodeAsync(address);
  return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
}
