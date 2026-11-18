import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import type { RiskEvent, SourceItem } from '../src/types.js';
import { storeBackends } from './backends.js';

const NOW = new Date('2026-11-14T09:50:00+01:00');

function item(externalId: string): SourceItem {
  return {
    source: 'rss', sourceName: 'Polizei Berlin', externalId, official: false,
    title: 'Polizeieinsatz', body: 'Am Ostkreuz', publishedAt: NOW.toISOString(),
  };
}

function event(id: string, over: Partial<RiskEvent> = {}): RiskEvent {
  return {
    id, revision: 1, status: 'auto', category: 'transit', severity: 3, confidence: 0.9, official: false,
    title: 'S-Bahn gesperrt', summary: 'Ostkreuz gesperrt', facts: '', areaName: 'Ostkreuz',
    lat: 52.503, lon: 13.469, radiusM: 1000, startsAt: NOW.toISOString(), endsAt: null,
    sources: [{ sourceName: 'S-Bahn Berlin', externalId: 'x', title: 'S-Bahn gesperrt', official: false }],
    copyTitle: null, copyBody: null, copyAction: null, copyIsTemplate: false,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

describe.each(storeBackends())('store contract ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('creates users with a hashed token and finds them by the plain token', async () => {
    const { user, token } = await store.createUser('ExponentPushToken[a]', { dailyLimit: 3 });
    expect(user.tokenHash).not.toBe(token);
    const found = await store.userByToken(token);
    expect(found?.id).toBe(user.id);
    expect(found?.prefs.dailyLimit).toBe(3);
    expect(await store.userByToken('wrong')).toBeNull();
  });

  it('keeps only the latest location', async () => {
    const { user } = await store.createUser(null);
    await store.updateLocation(user.id, 52.5, 13.4);
    await store.updateLocation(user.id, 48.1, 11.5);
    const u = await store.getUser(user.id);
    expect([u?.lat, u?.lon]).toEqual([48.1, 11.5]);
    expect(u?.locationUpdatedAt).toBeTruthy();
  });

  it('updates prefs and push token', async () => {
    const { user } = await store.createUser(null);
    await store.updatePrefs(user.id, { ...user.prefs, categories: ['weather'] });
    await store.updatePushToken(user.id, 'ExponentPushToken[b]');
    const u = await store.getUser(user.id);
    expect(u?.prefs.categories).toEqual(['weather']);
    expect(u?.pushToken).toBe('ExponentPushToken[b]');
  });

  it('saved places belong to their user', async () => {
    const a = (await store.createUser(null)).user;
    const b = (await store.createUser(null)).user;
    const p = await store.addPlace(a.id, 'Mama', 52.51, 13.45, 500);
    await store.deletePlace(b.id, p.id); // not b's place: no effect
    expect(await store.places(a.id)).toEqual([p]);
    await store.deletePlace(a.id, p.id);
    expect(await store.places(a.id)).toEqual([]);
  });

  it('records each source item once', async () => {
    expect(await store.hasSourceItem('rss', 'a')).toBe(false);
    expect(await store.recordSourceItem(item('a'))).toBe(true);
    expect(await store.recordSourceItem(item('a'))).toBe(false);
    expect(await store.hasSourceItem('rss', 'a')).toBe(true);
    await store.saveEvent(event('e1'));
    await store.linkSourceItem(item('a'), 'e1');
  });

  it('saves, updates and filters events', async () => {
    await store.saveEvent(event('live'));
    await store.saveEvent(event('ended', { endsAt: new Date(NOW.getTime() - 60_000).toISOString() }));
    await store.saveEvent(event('old', { startsAt: new Date(NOW.getTime() - 48 * 3600_000).toISOString() }));
    await store.saveEvent(event('rejected', { status: 'rejected' }));
    await store.saveEvent(event('pending', { status: 'pending_review' }));
    expect((await store.activeEvents(NOW)).map((e) => e.id).sort()).toEqual(['live', 'pending']);
    // A warning that started three days ago but officially runs until tomorrow is still active;
    // times with an offset compare correctly.
    await store.saveEvent(event('multiday', {
      startsAt: new Date(NOW.getTime() - 72 * 3600_000).toISOString(),
      endsAt: '2026-11-15T20:00:00+01:00',
    }));
    await store.saveEvent(event('long-ago', { startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-20T00:00:00Z' }));
    await store.saveEvent(event('ended-offset', { endsAt: '2026-11-14T09:00:00+01:00' })); // 50 min before NOW
    expect((await store.activeEvents(NOW)).map((e) => e.id).sort()).toEqual(['live', 'multiday', 'pending']);

    await store.saveEvent(event('live', { severity: 4, revision: 2 }));
    expect((await store.getEvent('live'))?.severity).toBe(4);
    expect((await store.eventsByStatus('pending_review')).map((e) => e.id)).toEqual(['pending']);
    expect(await store.getEvent('nope')).toBeNull();
  });

  it('stores event embeddings and returns cosine similarity per event, same model and length only', async () => {
    for (const id of ['e1', 'e2', 'e3', 'e4']) await store.saveEvent(event(id));
    await store.saveEventEmbedding('e1', 'm1', [1, 0, 0]);
    await store.saveEventEmbedding('e2', 'm1', [0.6, 0.8, 0]);
    await store.saveEventEmbedding('e3', 'other-model', [1, 0, 0]);
    await store.saveEventEmbedding('e4', 'm1', [1, 0]); // different length: ignored, not an error
    const sims = await store.eventSimilarities(['e1', 'e2', 'e3', 'e4', 'missing'], 'm1', [1, 0, 0]);
    expect([...sims.keys()].sort()).toEqual(['e1', 'e2']);
    expect(sims.get('e1')).toBeCloseTo(1, 6);
    expect(sims.get('e2')).toBeCloseTo(0.6, 6);
    // Replacing a vector (e.g. a later model) overwrites the old one.
    await store.saveEventEmbedding('e1', 'm1', [0, 1, 0]);
    expect((await store.eventSimilarities(['e1'], 'm1', [1, 0, 0])).get('e1')).toBeCloseTo(0, 6);
    expect((await store.eventSimilarities([], 'm1', [1, 0, 0])).size).toBe(0);
  });

  it('alerts: one per user and revision, feedback, counts, metrics, GDPR delete', async () => {
    const { user } = await store.createUser('ExponentPushToken[c]');
    const base = {
      userId: user.id, eventId: 'e1', eventRevision: 1, title: 'T', body: 'B', action: 'A',
      category: 'transit' as const, severity: 3 as const, official: false, aiWritten: true,
      sourceName: 'S-Bahn Berlin', sourceUrl: null, lat: 52.5, lon: 13.4, radiusM: 1000,
      matchedPlace: null, delivery: 'push' as const, reason: 'relevant',
    };
    const a = await store.insertAlert(base);
    expect(a).not.toBeNull();
    expect(await store.insertAlert(base)).toBeNull();
    expect(await store.insertAlert({ ...base, eventRevision: 2, delivery: 'suppressed' })).not.toBeNull();
    expect(await store.hasAlertForEvent(user.id, 'e1')).toBe(true);
    expect(await store.pushCountSince(user.id, '2000-01-01T00:00:00Z')).toBe(1);

    const listed = await store.alertsForUser(user.id);
    expect(listed.map((x) => x.id)).toEqual([a!.id]); // suppressed alerts are not listed

    expect(await store.setFeedback(user.id, a!.id, 'not_relevant')).toBe(true);
    expect(await store.setFeedback('someone-else', a!.id, 'relevant')).toBe(false);
    expect((await store.getAlert(user.id, a!.id))?.feedback).toBe('not_relevant');
    // Ids straight from URLs: unknown or malformed ids are "not found", never an error.
    expect(await store.getAlert(user.id, 'nope')).toBeNull();
    expect(await store.setFeedback(user.id, 'nope', 'relevant')).toBe(false);
    expect(await store.getUser('nope')).toBeNull();
    await store.deletePlace(user.id, 'nope');
    expect(await store.feedbackByCategory(user.id)).toEqual({ transit: { relevant: 0, notRelevant: 1 } });

    const m = await store.metrics('2000-01-01T00:00:00Z');
    expect(m).toMatchObject({ alerts: 2, pushed: 1, rated: 1, relevantRate: 0, beyondNinaRate: null, pendingReview: 0 });

    await store.addPlace(user.id, 'Büro', 52.52, 13.41, 500);
    await store.deleteUser(user.id);
    expect(await store.getUser(user.id)).toBeNull();
    expect(await store.alertsForUser(user.id)).toEqual([]);
    expect(await store.places(user.id)).toEqual([]);
  });
});
