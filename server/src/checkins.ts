import { randomUUID } from 'node:crypto';
import type { Checkin, CheckinAnswer, Store } from './store.js';
import type { Alert, Category, Language, RiskEvent, User } from './types.js';
import { contentLanguage } from './types.js';
import { sortMembers } from './family.js';
import { inQuietHours } from './pipeline/rank.js';
import { packFor } from './countries.js';

/**
 * "Hey, okay?" check-ins (PRD 6.1 #8, 3.3 #4). After a severe event (severity 4+) where a family
 * member is (their current location or one of their own places), Hey-Okay asks them "Alles okay?".
 * One tap tells the family. A gentle reminder follows once if there's no answer. It never contacts
 * emergency services, and it never tells the family anything the person didn't choose to send:
 *
 * - The family only ever sees an answer: who, "ok" or "please call me", and when. Never the event,
 *   the place or that someone was asked (that alone would say where they are).
 * - Only people in a family of two or more are asked; nobody else would hear the answer.
 * - Only for the person's own zone, not for a place someone else shared with them (then it's the
 *   other person who should be asked, and they are, through their own alert).
 * - Only topics where "are you okay?" makes sense (CHECKIN_CATEGORIES), only when the alert itself
 *   went out as a push (not a catch-up after setup, not "coming up" later).
 *
 * The first ask rides on the alert's own push (its buttons are "Mir geht's gut" / "Bitte meldet
 * euch"), so a severe event is one notification, not two. The reminder after CHECKIN_REMIND_MIN is
 * the explicit "Alles okay?" push, sent at most once, not during the person's quiet hours, and not
 * once the event is over.
 */
export const CHECKIN_CATEGORIES: readonly Category[] = ['weather', 'crime', 'public_safety', 'health', 'infrastructure'];
export const CHECKIN_MIN_SEVERITY = 4;
/** The gentle reminder: this long after the ask, if there is no answer yet. */
export const CHECKIN_REMIND_MIN = 20;
/** No reminder for asks older than this (the moment has passed). */
export const CHECKIN_REMIND_UNTIL_H = 6;
/** Answers are accepted (and may be changed) for this long after the ask. */
export const CHECKIN_OPEN_H = 24;
/** The family sees each member's latest answer for this long. */
export const CHECKIN_SHOW_H = 24;

export const CHECKIN_ANSWERS = ['ok', 'call_me'] as const satisfies readonly CheckinAnswer[];

export class CheckinError extends Error {
  constructor(readonly code: 'not_found', readonly status: number) { super(code); }
}

/** Whether this alert may ask its person "Alles okay?" (the family part is checked by the caller). */
export function checkinEligible(event: Pick<RiskEvent, 'severity' | 'category'>, a: { kind: string; delivery: string; self: boolean; backfill: boolean; ahead: boolean }): boolean {
  return event.severity >= CHECKIN_MIN_SEVERITY && CHECKIN_CATEGORIES.includes(event.category)
    && a.kind === 'new' && a.delivery === 'push' && a.self && !a.backfill && !a.ahead;
}

/** Creates the check-in for this alert when the person is in a family with someone else. Returns its id. */
export async function askCheckin(store: Store, user: User, alert: Alert, now: Date): Promise<string | null> {
  const me = await store.familyMemberByUser(user.id);
  if (!me) return null;
  if ((await store.familyMembers(me.familyId)).length < 2) return null;
  const c: Checkin = { id: randomUUID(), userId: user.id, eventId: alert.eventId, alertId: alert.id, askedAt: now.toISOString(), remindedAt: null, answer: null, answeredAt: null };
  return (await store.createCheckin(c)) ? c.id : null;
}

const TEXT: Record<Language, {
  reminderTitle: string;
  reminderBody: (what: string) => string;
  okTitle: (name: string) => string;
  okBody: (name: string) => string;
  callTitle: (name: string) => string;
  callBody: (name: string) => string;
}> = {
  de: {
    reminderTitle: 'Alles okay?',
    reminderBody: (what) => `${what}. Ein Tipp sagt deiner Familie Bescheid.`,
    okTitle: (n) => `${n}: Alles okay`,
    okBody: (n) => `${n} hat sich gemeldet: Mir geht's gut.`,
    callTitle: (n) => `${n} bittet um einen Anruf`,
    callBody: (n) => `${n} möchte, dass sich jemand aus der Familie meldet.`,
  },
  en: {
    reminderTitle: 'Are you okay?',
    reminderBody: (what) => `${what}. One tap lets your family know.`,
    okTitle: (n) => `${n}: All okay`,
    okBody: (n) => `${n} checked in: I'm fine.`,
    callTitle: (n) => `${n} would like a call`,
    callBody: (n) => `${n} would like someone in the family to get in touch.`,
  },
};

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** The gentle follow-up push. Its id is the check-in's, so a receipt resend never repeats the alert. */
export function reminderPush(alert: Alert, checkinId: string, language: Language): Alert {
  const t = TEXT[language];
  return {
    ...alert,
    id: checkinId,
    title: t.reminderTitle,
    body: cut(t.reminderBody(alert.title), 178),
    severity: 3, // a normal notification, not time-sensitive
    delivery: 'push',
    reason: 'checkin reminder',
    checkin: { id: checkinId, kind: 'reminder', alertId: alert.id },
  };
}

/** What a family member's phone shows when someone answers. No event, no place, no coordinates. */
export function answerPush(recipientId: string, checkinId: string, name: string, answer: CheckinAnswer, language: Language, now: Date): Alert {
  const t = TEXT[language];
  const ok = answer === 'ok';
  return {
    id: checkinId, userId: recipientId, eventId: checkinId, eventRevision: 0,
    title: cut(ok ? t.okTitle(name) : t.callTitle(name), 50),
    body: cut(ok ? t.okBody(name) : t.callBody(name), 178),
    action: '', category: 'public_safety',
    // A request for a call is worth breaking through; "I'm fine" is a quiet notification.
    severity: ok ? 1 : 4,
    official: false, aiWritten: false, sourceName: 'Hey-Okay', sourceUrl: null,
    lat: 0, lon: 0, radiusM: 0, matchedPlace: null, delivery: 'push', reason: 'checkin answer', kind: 'update',
    feedback: null, createdAt: now.toISOString(),
    checkin: { id: checkinId, kind: 'answer' },
  };
}

/** What the person sees about their own check-ins (the app's "Alles okay?" card). */
export interface CheckinView {
  id: string;
  alertId: string;
  /** The alert's title: what it is about. Only ever shown to the person themself. */
  title: string | null;
  askedAt: string;
  answer: CheckinAnswer | null;
  answeredAt: string | null;
  /** The emergency number where the event is (112, 911), for a calm "in an emergency" line in the app. */
  emergency: string;
}

async function viewOf(store: Store, userId: string, c: Checkin): Promise<CheckinView> {
  const event = await store.getEvent(c.eventId);
  return {
    id: c.id, alertId: c.alertId, title: (await store.getAlert(userId, c.alertId))?.title ?? null,
    askedAt: c.askedAt, answer: c.answer, answeredAt: c.answeredAt,
    emergency: packFor({ country: event?.country, language: event?.language }).numbers.emergency,
  };
}

/** This person's check-ins of the last CHECKIN_OPEN_H, newest first; none when they are not in a family. */
export async function myCheckins(store: Store, userId: string, now: Date): Promise<CheckinView[]> {
  if (!(await store.familyMemberByUser(userId))) return [];
  const since = new Date(now.getTime() - CHECKIN_OPEN_H * 3600_000).toISOString();
  const list = await store.checkinsForUser(userId, since);
  return Promise.all(list.map((c) => viewOf(store, userId, c)));
}

/**
 * Records the answer and tells the rest of the family (a push each; "ok" waits out their quiet
 * hours, i.e. they see it in the app instead). Answering the same thing twice tells nobody again.
 * Returns the check-in and how many people in the family can now see the answer.
 */
export async function answerCheckin(
  store: Store, send: (outbox: Array<{ token: string; alert: Alert }>) => Promise<number>,
  userId: string, id: string, answer: CheckinAnswer, now: Date,
): Promise<{ checkin: CheckinView; told: number }> {
  const before = (await store.checkinsForUser(userId, new Date(now.getTime() - CHECKIN_OPEN_H * 3600_000).toISOString())).find((c) => c.id === id);
  if (!before) throw new CheckinError('not_found', 404);
  const c = await store.answerCheckin(userId, id, answer, now.toISOString(), new Date(now.getTime() - CHECKIN_OPEN_H * 3600_000).toISOString());
  if (!c) throw new CheckinError('not_found', 404);
  const view = await viewOf(store, userId, c);

  const me = await store.familyMemberByUser(userId);
  if (!me) return { checkin: view, told: 0 };
  const others = sortMembers(await store.familyMembers(me.familyId)).filter((m) => m.userId !== userId);
  if (before.answer === answer) return { checkin: view, told: others.length };
  const outbox: Array<{ token: string; alert: Alert }> = [];
  for (const m of others) {
    const u = await store.getUser(m.userId);
    if (!u?.pushToken) continue;
    const quiet = !!u.prefs.quietHours && inQuietHours(now, u.prefs.quietHours.start, u.prefs.quietHours.end, u.prefs.timezone);
    if (answer === 'ok' && quiet) continue;
    outbox.push({ token: u.pushToken, alert: answerPush(u.id, c.id, me.name, answer, contentLanguage(u.prefs.language), now) });
  }
  await send(outbox);
  return { checkin: view, told: others.length };
}

/** The family's latest answers (one per member, last CHECKIN_SHOW_H), by member id as in the family view. */
export async function familyCheckins(store: Store, members: Array<{ id: string; userId: string; joinedAt: string }>, now: Date): Promise<Array<{ memberId: string; answer: CheckinAnswer; answeredAt: string }>> {
  const since = new Date(now.getTime() - CHECKIN_SHOW_H * 3600_000).toISOString();
  const memberOf = new Map(members.map((m) => [m.userId, m]));
  const seen = new Set<string>();
  const out: Array<{ memberId: string; answer: CheckinAnswer; answeredAt: string }> = [];
  for (const c of await store.checkinAnswers(members.map((m) => m.userId), since)) {
    const m = memberOf.get(c.userId);
    // Only check-ins from while they were in this family: a new family doesn't learn about the time before.
    if (!m || seen.has(c.userId) || !c.answer || !c.answeredAt || c.askedAt < m.joinedAt) continue;
    seen.add(c.userId);
    out.push({ memberId: m.id, answer: c.answer, answeredAt: c.answeredAt });
  }
  return out;
}
