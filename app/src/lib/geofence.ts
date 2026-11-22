/**
 * OS geofencing (PRD 5.3, 11): the pure planning part, no Expo imports (tested in app/test).
 *
 * Regions the phone watches, at most 20 (the iOS limit):
 * - "home": the area around the last known position (exit only). Leaving it wakes the app, which
 *   sends the new position and re-centres the area. Moving across town is noticed this way even
 *   when continuous updates are paused by the system.
 * - active events nearby (from the server, enter only): walking into one sends the position at once.
 * - saved places (enter only): arriving at one sends the position, so the feed matches where you are.
 */
export const HOME_ID = 'home';
export const HOME_RADIUS_M = 1000;
export const MAX_REGIONS = 20;
/** Below this the OS doesn't reliably notice a region. */
export const MIN_RADIUS_M = 200;

export interface Circle { id: string; lat: number; lon: number; radiusM: number }

/** Same shape as expo-location's LocationRegion. */
export interface Region { identifier: string; latitude: number; longitude: number; radius: number; notifyOnEnter: boolean; notifyOnExit: boolean }

const round = (v: number) => Math.round(v * 1000) / 1000;

export function planRegions(here: { lat: number; lon: number } | null, events: Circle[], places: Circle[], max = MAX_REGIONS): Region[] {
  const out: Region[] = [];
  if (here) out.push({ identifier: HOME_ID, latitude: round(here.lat), longitude: round(here.lon), radius: HOME_RADIUS_M, notifyOnEnter: false, notifyOnExit: true });
  const add = (prefix: string, c: Circle) => out.push({
    identifier: `${prefix}:${c.id}`, latitude: c.lat, longitude: c.lon, radius: Math.max(MIN_RADIUS_M, Math.round(c.radiusM)), notifyOnEnter: true, notifyOnExit: false,
  });
  for (const e of events) if (out.length < max) add('event', e);
  for (const p of places) if (out.length < max) add('place', p);
  return out;
}

/** Restarting geofencing re-registers every region; skip it when nothing changed. */
export function sameRegions(a: Region[], b: Region[]): boolean {
  const key = (r: Region) => `${r.identifier}|${r.latitude}|${r.longitude}|${r.radius}|${r.notifyOnEnter}|${r.notifyOnExit}`;
  return a.length === b.length && a.map(key).sort().join() === b.map(key).sort().join();
}

/** 1 = enter, 2 = exit (expo-location GeofencingEventType). */
export type GeofenceReaction = 'recentre' | 'send' | 'ignore';

export function reactTo(eventType: number, identifier: string | undefined): GeofenceReaction {
  if (identifier === HOME_ID) return eventType === 2 ? 'recentre' : 'ignore';
  if (eventType === 1 && identifier && /^(event|place):/.test(identifier)) return 'send';
  return 'ignore';
}
