/**
 * Data retention (PRD 11, GDPR Art. 5(1)(e)): how long each kind of data is kept. The worker's
 * `retention` task deletes what is older, once an hour (`Store.purgeExpired`).
 *
 * - alerts (what a person was sent) and push tickets: 30 days;
 * - a person's last location: cleared when not updated for 30 days (the person stays);
 * - source items (raw feed entries): 7 days, but not while the event they belong to is running
 *   (updates and cancellations find their event through them);
 * - events: 120 days after they ended (or began, without an end), so the quarterly crime bias
 *   review still has the last quarter, plus a month to look at it;
 * - expired desk sessions and family invite codes, sign-in codes a day after they expired, stuck delivery jobs after a day,
 *   daily-summary markers after 30 days;
 * - the decision log: kept until Flori decides (CHANGELOG → Open questions);
 * - daily totals (AI spend, app event counts): kept, they name nobody.
 */
export const RETENTION = {
  alertsDays: 30,
  locationDays: 30,
  sourceItemsDays: 7,
  eventsDays: 120,
  pushTicketsDays: 30,
  digestsDays: 30,
  pushJobsDays: 1,
  emailCodesDays: 1,
} as const;

export interface RetentionReport {
  alerts: number;
  pushTickets: number;
  locationsCleared: number;
  sourceItems: number;
  events: number;
  pushJobs: number;
  digests: number;
  emailCodes: number;
  reviewerSessions: number;
  familyInvites: number;
}

export const daysBefore = (nowIso: string, days: number) => new Date(Date.parse(nowIso) - days * 86_400_000).toISOString();
