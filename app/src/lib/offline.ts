import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Alert, AlertDetail } from './types';

/**
 * Offline feed (PRD 5.3): the last 20 alerts and their details stay on the phone, so the app still
 * shows what's going on without a connection, with a "Stand: …" / "As of …" note.
 * Cleared on sign-out / delete (session.clear removes everything under this prefix too).
 */
const FEED_KEY = 'heyokay.offline.feed';
const DETAIL_KEY = (id: string) => `heyokay.offline.alert.${id}`;
export const OFFLINE_LIMIT = 20;

export interface CachedFeed { alerts: Alert[]; savedAt: string }

export async function saveFeed(alerts: Alert[], now = new Date()): Promise<void> {
  const keep = alerts.slice(0, OFFLINE_LIMIT);
  const previous = await loadFeed();
  await AsyncStorage.setItem(FEED_KEY, JSON.stringify({ alerts: keep, savedAt: now.toISOString() } satisfies CachedFeed)).catch(() => null);
  // Details of alerts that dropped out of the last 20 are removed.
  const kept = new Set(keep.map((a) => a.id));
  const stale = (previous?.alerts ?? []).filter((a) => !kept.has(a.id)).map((a) => DETAIL_KEY(a.id));
  if (stale.length) await AsyncStorage.multiRemove(stale).catch(() => null);
}

export async function loadFeed(): Promise<CachedFeed | null> {
  try {
    const raw = await AsyncStorage.getItem(FEED_KEY);
    return raw ? (JSON.parse(raw) as CachedFeed) : null;
  } catch {
    return null;
  }
}

/** Details are cached when opened, and only for alerts in the cached feed. */
export async function saveDetail(detail: AlertDetail): Promise<void> {
  const feed = await loadFeed();
  if (!feed?.alerts.some((a) => a.id === detail.alert.id)) return;
  await AsyncStorage.setItem(DETAIL_KEY(detail.alert.id), JSON.stringify(detail)).catch(() => null);
}

export async function loadDetail(id: string): Promise<AlertDetail | null> {
  try {
    const raw = await AsyncStorage.getItem(DETAIL_KEY(id));
    return raw ? (JSON.parse(raw) as AlertDetail) : null;
  } catch {
    return null;
  }
}

export async function clearOffline(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys().catch(() => [])).filter((k) => k.startsWith('heyokay.offline.'));
  if (keys.length) await AsyncStorage.multiRemove(keys).catch(() => null);
}
