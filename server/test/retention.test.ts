import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import type { Alert, RiskEvent, SourceItem } from '../src/types.js';
import { storeBackends } from './backends.js';
import { RETENTION } from '../src/retention.js';

// PRD 11 / GDPR: data is deleted when its time is up; running events keep what they need.

const DAY = 86_400_000;
const T0 = Date.now();
const at = (days: number) => new Date(T0 + days * DAY).toISOString();

function event(id: string, startsDays: number, endsDays: number | null, over: Partial<RiskEvent> = {}): RiskEvent {
  return {
    id, revision: 1, status: 'auto', category: 'public_safety', severity: 3, confidence: 1, official: true,
    title: id, summary: '', facts: '', areaName: 'Mitte', lat: 52.52, lon: 13.4, radiusM: 1000,
    startsAt: at(startsDays), endsAt: endsDays == null ? null : at(endsDays),
    sources: [], copyTitle: null, copyBody: null, copyAction: null, copyIsTemplate: true,
    createdAt: at(startsDays), updatedAt: at(startsDays), ...over,
  };
}
const item = (id: string): SourceItem => ({ source: 'nina', sourceName: 'NINA', externalId: id, official: true, title: id, body: '', publishedAt: at(0) });
function alert(userId: string, eventId: string, createdDays: number): Omit<Alert, 'id' | 'createdAt' | 'feedback'> & { createdAt: string } {
  return {
    userId, eventId, eventRevision: 1, title: 'T', body: 'B', action: 'A', category: 'public_safety', severity: 3, official: true, aiWritten: false,
    sourceName: 'NINA', sourceUrl: null, lat: 52.52, lon: 13.4, radiusM: 1000, matchedPlace: null, delivery: 'feed', reason: 'test', kind: 'new',
    createdAt: at(createdDays),
  } as never;
}

describe.each(storeBackends())('data retention ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('deletes alerts, stale locations, old raw items and long-ended events; keeps what is still needed', async () => {
    const { user } = await store.createUser('ExponentPushToken[a]');
    await store.updateLocation(user.id, 52.52, 13.4); // now
    const { user: fresh } = await store.createUser(null);

    // Events: running (ends in 40 days), ended 100 days before T0, open-ended from T0, rejected long ago.
    await store.saveEvent(event('running', -1, 40));
    await store.saveEvent(event('old', -110, -100));
    await store.saveEvent(event('open', 0, null));
    await store.saveEvent(event('rejected', -200, null, { status: 'rejected' }));
    for (const [id, ev] of [['i-running', 'running'], ['i-old', 'old'], ['i-open', 'open']] as const) {
      await store.recordSourceItem(item(id));
      await store.linkSourceItem(item(id), ev);
    }
    await store.recordSourceItem(item('i-ignored')); // never became an event

    await store.insertAlert(alert(user.id, 'open', 0)); // 31 days old at purge time
    await store.insertAlert(alert(user.id, 'running', 20)); // 11 days old

    // 31 days later, the location is 31 days old; then fresh's is updated "now" (of that day).
    const now = at(31);
    const r = await store.purgeExpired(now);
    expect(r).toMatchObject({ alerts: 1, locationsCleared: 1, events: 2 });
    // i-old (its event ended) and i-ignored (no event) go; i-running and i-open (no end yet) stay.
    expect(r.sourceItems).toBe(2);
    expect((await store.getEvent('running'))?.id).toBe('running');
    expect((await store.getEvent('open'))?.id).toBe('open');
    expect(await store.getEvent('old')).toBeNull();
    expect(await store.getEvent('rejected')).toBeNull();
    // Running events keep their raw items, so an update still finds them.
    expect(await store.eventIdForSourceRefs('nina', ['i-running'])).toBe('running');
    expect(await store.hasSourceItem('nina', 'i-old')).toBe(false);
    expect(await store.hasSourceItem('nina', 'i-ignored')).toBe(false);
    // The person stays; only the location goes.
    const u = await store.getUser(user.id);
    expect(u).not.toBeNull();
    expect([u!.lat, u!.lon]).toEqual([null, null]);
    expect((await store.alertsForUser(user.id)).map((a) => a.eventId)).toEqual(['running']);
    expect(await store.getUser(fresh.id)).not.toBeNull();

    // Running it again changes nothing.
    expect(Object.values(await store.purgeExpired(now)).every((n) => n === 0)).toBe(true);
  });

  it('expired sessions and sign-in codes; within their time nothing goes', async () => {
    await store.saveEmailCode({ email: 'a@b.de', codeHash: 'x', expiresAt: at(0), attempts: 0, sends: 1, windowStart: at(0) });
    await store.createReviewer({ id: '00000000-0000-4000-8000-0000000000aa', email: 'r@b.de', name: 'R', passwordHash: 'h', createdAt: at(0), disabled: false });
    await store.createReviewerSession('s1', '00000000-0000-4000-8000-0000000000aa', at(0.5));
    expect(Object.values(await store.purgeExpired(at(0.25))).every((n) => n === 0)).toBe(true);
    const r = await store.purgeExpired(at(RETENTION.emailCodesDays + 0.1));
    expect(r).toMatchObject({ emailCodes: 1, reviewerSessions: 1 });
    expect(await store.emailCode('a@b.de')).toBeNull();
  });
});
