import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { rateFromNotification } from './feedback-queue';
import { translate, type Lang } from './i18n';
import type { Feedback } from './types';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Channels match server/src/push.ts: severity ≥ 4 uses "urgent". */
export async function setupChannels(lang: Lang) {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('alerts', {
    name: translate(lang, 'channel.alerts'),
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  await Notifications.setNotificationChannelAsync('urgent', {
    name: translate(lang, 'channel.urgent'),
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 400, 200, 400],
  });
}

export async function requestPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const res = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return res.granted;
}

/** Returns null on simulators or when permission is missing — the feed still works without push. */
export async function getPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (!(await Notifications.getPermissionsAsync()).granted) return null;
  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
    Constants.easConfig?.projectId;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return data;
  } catch {
    return null;
  }
}

/** The server sends data.alertId with every push. */
export function alertIdFrom(response: Notifications.NotificationResponse): string | null {
  const id = response.notification.request.content.data?.alertId;
  return typeof id === 'string' ? id : null;
}

// ── "Relevant" / "Nicht relevant" buttons on every alert (PRD 5.3) ─────────
/** Must match `categoryId` in server/src/push.ts. No ":" or "-" allowed in the id. */
export const ALERT_CATEGORY = 'alert';
const ACTIONS: Record<string, Feedback> = { relevant: 'relevant', not_relevant: 'not_relevant' };

/** Registers the buttons (titles in the current language). Rating doesn't open the app. */
export async function setupCategories(lang: Lang) {
  await Notifications.setNotificationCategoryAsync(ALERT_CATEGORY, [
    { identifier: 'relevant', buttonTitle: translate(lang, 'notif.relevant'), options: { opensAppToForeground: false } },
    { identifier: 'not_relevant', buttonTitle: translate(lang, 'notif.notRelevant'), options: { opensAppToForeground: false } },
  ]).catch(() => null); // Expo Go / web: no categories
}

/** The rating behind a button tap, or null for a normal tap (open the alert). */
export function ratingFrom(response: Pick<Notifications.NotificationResponse, 'actionIdentifier'>): Feedback | null {
  return ACTIONS[response.actionIdentifier] ?? null;
}

/**
 * Handles a tap. A button tap records the rating (and doesn't navigate); a normal tap returns the
 * alert id to open.
 */
export async function handleResponse(response: Notifications.NotificationResponse): Promise<string | null> {
  const id = alertIdFrom(response);
  const rating = ratingFrom(response);
  if (id && rating) {
    await rateFromNotification(id, rating);
    await Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(() => null);
    return null;
  }
  return id;
}

/**
 * Android runs this task for button taps while the app is in the background or closed; on iOS the
 * response listener gets them, and anything missed waits in the feedback queue.
 * Defined at module scope, so this file must be imported early (root layout).
 */
export const NOTIFICATION_TASK = 'heyokay-notification';
TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_TASK, async ({ data }) => {
  if (data && 'actionIdentifier' in data) await handleResponse(data as Notifications.NotificationResponse);
  return Notifications.BackgroundNotificationTaskResult.NoData;
});

export async function registerNotificationTask() {
  await Notifications.registerTaskAsync(NOTIFICATION_TASK).catch(() => null);
}
