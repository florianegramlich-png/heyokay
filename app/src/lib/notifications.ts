import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { answerFromNotification, rateFromNotification } from './feedback-queue';
import { translate, type Lang } from './i18n';
import { ALERT_CATEGORY, CHECKIN_CATEGORY, pushTarget } from './push-target';

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

// ── Notification buttons (PRD 5.3, 6.1 #8) ──────────────────────────────────
// "Relevant" / "Nicht relevant" on every alert; "Mir geht’s gut" / "Bitte meldet euch" on a
// "Hey, okay?" check-in. What a tap means is in push-target.ts.
export { ALERT_CATEGORY, CHECKIN_CATEGORY };

/** Registers the buttons (titles in the current language). Rating and "I'm fine" don't open the app. */
export async function setupCategories(lang: Lang) {
  await Notifications.setNotificationCategoryAsync(ALERT_CATEGORY, [
    { identifier: 'relevant', buttonTitle: translate(lang, 'notif.relevant'), options: { opensAppToForeground: false } },
    { identifier: 'not_relevant', buttonTitle: translate(lang, 'notif.notRelevant'), options: { opensAppToForeground: false } },
  ]).catch(() => null); // Expo Go / web: no categories
  await Notifications.setNotificationCategoryAsync(CHECKIN_CATEGORY, [
    { identifier: 'ok', buttonTitle: translate(lang, 'fam.ci.ok'), options: { opensAppToForeground: false } },
    // Opens the app: the card there shows the emergency number, calmly, for the person themself.
    { identifier: 'call_me', buttonTitle: translate(lang, 'fam.ci.callMe'), options: { opensAppToForeground: true } },
  ]).catch(() => null);
}

/** Where a tap should lead after it is handled: an alert, the family section, or nowhere. */
export type OpenTarget = { alertId: string } | 'family' | null;

/**
 * Handles a tap. A rating button records the rating; a check-in button sends the answer (and
 * "Bitte meldet euch" opens the alert, whose card shows the emergency number); a normal tap opens
 * the alert, or the family for a family member's answer.
 */
export async function handleResponse(response: Notifications.NotificationResponse): Promise<OpenTarget> {
  const target = pushTarget(response.notification.request.content.data, response.actionIdentifier);
  const dismiss = () => Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(() => null);
  if (!target) return null;
  if (target.kind === 'rate') { await rateFromNotification(target.alertId, target.value); await dismiss(); return null; }
  if (target.kind === 'checkin') {
    await answerFromNotification(target.checkinId, target.answer);
    await dismiss();
    return target.answer === 'call_me' && target.alertId ? { alertId: target.alertId } : null;
  }
  if (target.kind === 'family') return 'family';
  return { alertId: target.alertId };
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
