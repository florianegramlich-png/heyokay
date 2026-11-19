import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { fold, searchHistory } from '../src/history.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';
import type { Alert } from '../src/types.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { buildApi } from '../src/api.js';

// PRD 5.3: searchable alert history — one entry per incident, the person's own alerts only.

const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
const OSTKREUZ = { lat: 52.5031, lon: 13.4691 };

const alert = (o: Partial<Alert>): Alert => ({
  id: 'a', userId: 'u', eventId: 'e', eventRevision: 1, title: 'T', body: 'B', action: '', category: 'transit', severity: 2,
  official: false, aiWritten: false, sourceName: 'S', sourceUrl: null, lat: 0, lon: 0, radiusM: 1, matchedPlace: null,
  delivery: 'feed', reason: 'r', kind: 'new', feedback: null, createdAt: '2026-11-19T10:00:00.000Z', ...o,
});

describe('history search', () => {
  it('folds case, accents and ß', () => {
    expect(fold('Straße KÖLN')).toBe('strasse koln');
  });

  it('one entry per incident in its latest state; words match the whole story; topic filter', () => {
    const list = [
      alert({ id: '1', eventId: 'e1', title: 'S-Bahn Ostkreuz gesperrt', body: 'Bis 14 Uhr kein Zugverkehr.', createdAt: '2026-11-18T10:00:00Z' }),
      alert({ id: '2', eventId: 'e1', eventRevision: 2, kind: 'all_clear', title: 'Entwarnung: S-Bahn Ostkreuz gesperrt', body: 'Die Warnung ist aufgehoben.', createdAt: '2026-11-18T13:00:00Z' }),
      alert({ id: '3', eventId: 'e2', category: 'weather', title: 'Sturmböen', body: 'Böen bis 75 km/h.', matchedPlace: 'Büro', createdAt: '2026-11-19T08:00:00Z' }),
      alert({ id: '4', eventId: 'e3', title: 'Hidden', delivery: 'suppressed' }),
    ];
    expect(searchHistory(list, {}).map((a) => a.id)).toEqual(['3', '2']);
    expect(searchHistory(list, { q: 'zugverkehr ostkreuz' }).map((a) => a.id)).toEqual(['2']); // found via the first alert's text
    expect(searchHistory(list, { q: 'buro' }).map((a) => a.id)).toEqual(['3']); // saved place, no accent typed
    expect(searchHistory(list, { q: 'sturm regen' })).toEqual([]); // every word must match
    expect(searchHistory(list, { category: 'weather' }).map((a) => a.id)).toEqual(['3']);
    expect(searchHistory(list, { q: 'hidden' })).toEqual([]);
  });
});

describe.each(storeBackends())('history API ($name)', (backend) => {
  let store: Store, pipeline: Pipeline, clock: Date;

  beforeEach(async () => {
    clock = new Date('2026-11-17T12:00:00+01:00');
    store = await backend.make();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => clock });
  });
  afterEach(async () => { await store.close(); });

  it('finds past alerts by word and topic, marks lifted ones, needs the person’s own token', async () => {
    const me = await store.createUser('ExponentPushToken[h]', { language: 'de', timezone: 'Europe/Berlin', quietHours: null });
    await store.updateLocation(me.user.id, OSTKREUZ.lat, OSTKREUZ.lon);
    const other = await store.createUser('ExponentPushToken[o]', { language: 'de', timezone: 'Europe/Berlin' });
    const app = buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock });
    const base = { body: 'Details.', sourceName: 'Hey-Okay Redaktion', lat: OSTKREUZ.lat, lon: OSTKREUZ.lon, radiusM: 1500, areaName: 'Berlin-Friedrichshain' };
    const sbahn = await pipeline.manualAlert({ ...base, category: 'transit', severity: 3, title: 'S-Bahn Ostkreuz gesperrt' });
    clock = new Date('2026-11-17T14:00:00+01:00');
    await pipeline.endEvent(sbahn.eventId);
    clock = new Date('2026-11-18T09:00:00+01:00');
    await pipeline.manualAlert({ ...base, category: 'weather', severity: 2, title: 'Glätte am Morgen' });

    const get = (token: string, qs = '') => app.inject({ method: 'GET', url: `/v1/me/history${qs}`, headers: { authorization: `Bearer ${token}` } });
    const all = (await get(me.token)).json().alerts as Array<{ title: string; kind: string; ended: boolean }>;
    expect(all.map((a) => [a.title, a.kind, a.ended])).toEqual([
      ['Glätte am Morgen', 'new', false],
      ['Entwarnung: S-Bahn Ostkreuz gesperrt', 'all_clear', true],
    ]);
    expect((await get(me.token, '?q=s-bahn')).json().alerts).toHaveLength(1);
    expect((await get(me.token, '?q=glatte')).json().alerts[0].title).toBe('Glätte am Morgen');
    expect((await get(me.token, '?category=weather')).json().alerts).toHaveLength(1);
    expect((await get(me.token, '?category=volcano')).statusCode).toBe(400);
    expect((await get(other.token)).json().alerts).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/me/history' })).statusCode).toBe(401);
  });
});
