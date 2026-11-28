import type { Feedback } from './types';
import type { CheckinAnswer } from './family';

/**
 * What a notification tap means (pure, so test/checkins.test.ts can check it without Expo).
 * Push payloads come from server/src/push.ts:
 * - alerts: `{ alertId, eventId, url }`, category "alert" (buttons Relevant / Nicht relevant);
 * - a "Hey, okay?" ask or reminder: the same plus `checkinId`, category "checkin" (buttons
 *   "Mir geht’s gut" / "Bitte meldet euch");
 * - a family member's answer: `{ checkinId, url: 'heyokay://family' }`, no buttons.
 */
export type PushTarget =
  | { kind: 'rate'; alertId: string; value: Feedback }
  | { kind: 'checkin'; checkinId: string; answer: CheckinAnswer; alertId: string | null }
  | { kind: 'open'; alertId: string }
  | { kind: 'family' }
  | null;

/** Must match server/src/push.ts. No ":" or "-" in category or action ids. */
export const ALERT_CATEGORY = 'alert';
export const CHECKIN_CATEGORY = 'checkin';
const RATINGS: Record<string, Feedback> = { relevant: 'relevant', not_relevant: 'not_relevant' };
const ANSWERS: Record<string, CheckinAnswer> = { ok: 'ok', call_me: 'call_me' };

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export function pushTarget(data: Record<string, unknown> | null | undefined, actionIdentifier: string): PushTarget {
  const alertId = str(data?.alertId);
  const checkinId = str(data?.checkinId);
  if (checkinId && ANSWERS[actionIdentifier]) return { kind: 'checkin', checkinId, answer: ANSWERS[actionIdentifier], alertId };
  if (alertId && RATINGS[actionIdentifier]) return { kind: 'rate', alertId, value: RATINGS[actionIdentifier] };
  if (alertId) return { kind: 'open', alertId };
  if (checkinId && data?.url === 'heyokay://family') return { kind: 'family' };
  return null;
}
