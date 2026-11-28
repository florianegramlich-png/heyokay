import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import type { Feedback } from './types';
import type { CheckinAnswer } from './family';

/**
 * Ratings from the notification buttons. They're sent right away; if that fails (offline, or the
 * phone only gave the app a moment in the background) they wait here and go out on the next start.
 */
const KEY = 'heyokay.pendingFeedback';

type Pending = { alertId: string; value: Feedback };

async function load(): Promise<Pending[]> {
  try { return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]'); } catch { return []; }
}

export async function rateFromNotification(alertId: string, value: Feedback, send = api.feedback) {
  try {
    await send(alertId, value);
  } catch {
    const pending = (await load()).filter((p) => p.alertId !== alertId);
    await AsyncStorage.setItem(KEY, JSON.stringify([...pending, { alertId, value }])).catch(() => null);
  }
}

// "Hey, okay?" answers from the notification buttons: same idea, so a tap offline isn't lost.
const CHECKIN_KEY = 'heyokay.pendingCheckins';
type PendingCheckin = { checkinId: string; answer: CheckinAnswer };

async function loadCheckins(): Promise<PendingCheckin[]> {
  try { return JSON.parse((await AsyncStorage.getItem(CHECKIN_KEY)) ?? '[]'); } catch { return []; }
}

export async function answerFromNotification(checkinId: string, answer: CheckinAnswer, send = api.answerCheckin) {
  try {
    await send(checkinId, answer);
  } catch {
    const pending = (await loadCheckins()).filter((p) => p.checkinId !== checkinId);
    await AsyncStorage.setItem(CHECKIN_KEY, JSON.stringify([...pending, { checkinId, answer }])).catch(() => null);
  }
}

async function flushPendingCheckins(send = api.answerCheckin) {
  const pending = await loadCheckins();
  if (!pending.length) return;
  const left: PendingCheckin[] = [];
  for (const p of pending) {
    try { await send(p.checkinId, p.answer); } catch (err) {
      if ((err as { status?: number }).status !== 404) left.push(p); // 404: closed or gone
    }
  }
  await AsyncStorage.setItem(CHECKIN_KEY, JSON.stringify(left)).catch(() => null);
}

/** Sends what's waiting (ratings and check-in answers); keeps only what still fails. */
export async function flushPendingFeedback(send = api.feedback) {
  await flushPendingCheckins();
  const pending = await load();
  if (!pending.length) return;
  const left: Pending[] = [];
  for (const p of pending) {
    try { await send(p.alertId, p.value); } catch (err) {
      // 404: the alert is gone (data deleted, or expired): nothing left to rate.
      if ((err as { status?: number }).status !== 404) left.push(p);
    }
  }
  await AsyncStorage.setItem(KEY, JSON.stringify(left)).catch(() => null);
}
