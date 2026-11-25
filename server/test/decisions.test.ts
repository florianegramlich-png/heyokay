import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { z } from 'zod';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM, type StructuredLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { EXTRACT_PROMPT_VERSION } from '../src/pipeline/extract.js';
import { COMPOSE_PROMPT_VERSION } from '../src/pipeline/compose.js';
import { decisionsCsv } from '../src/decisions.js';
import type { Decision, SourceItem } from '../src/types.js';

// PRD 6.3 (EU AI Act): every pipeline decision and every Alert Desk action is recorded.

const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
let clock = new Date('2026-11-23T10:00:00+01:00');
const FRIEDRICHSHAIN = { lat: 52.5155, lon: 13.4549 };

const rss = (id: string, title: string, body: string): SourceItem => ({
  source: 'rss', sourceName: 'Polizei Berlin', externalId: id, official: false, title, body, publishedAt: clock.toISOString(), language: 'de',
});

/** Extraction from a "model"; its first alert text invents a number, the second is fine. */
class FakeModel implements StructuredLLM {
  readonly enabled = true;
  lastModel: string | null = null;
  private copies = 0;
  async generate<T extends z.ZodType>(system: string): Promise<z.infer<T> | null> {
    this.lastModel = 'anthropic:test-model';
    if (system.startsWith('You extract')) {
      return { isCurrentSafetyEvent: true, category: 'transit', severity: 3, confidence: 0.9, title: 'U5 unterbrochen', summary: 'Die U5 ist unterbrochen.', place: 'Friedrichshain', radiusM: 1000, endsAt: null } as z.infer<T>;
    }
    this.copies++;
    return (this.copies === 1 ? { title: 'U5 unterbrochen', body: 'Seit 45 Minuten' } : { title: 'U5 unterbrochen', body: 'Ersatzverkehr mit Bussen' }) as z.infer<T>;
  }
}

describe.each(storeBackends())('decision log ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); clock = new Date('2026-11-23T10:00:00+01:00'); });
  afterEach(async () => { await store.close(); });

  const row = (id: string, at: string, o: Partial<Decision> = {}): Decision => ({
    id, at, kind: 'extract', actor: 'pipeline', eventId: null, sourceRef: null, model: null, promptVersion: null, outcome: 'dropped', detail: {}, ...o,
  });

  it('stores and queries: newest first, by event, step, time and limit', async () => {
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    await store.recordDecision(row(ids[0], '2026-11-23T08:00:00.000Z', { eventId: 'e1', detail: { a: 1 } }));
    await store.recordDecision(row(ids[1], '2026-11-23T09:00:00.000Z', { eventId: 'e1', kind: 'desk', actor: 'desk', outcome: 'approved' }));
    await store.recordDecision(row(ids[2], '2026-11-23T10:00:00.000Z', { eventId: 'e2' }));
    expect((await store.decisions({})).map((d) => d.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect((await store.decisions({ eventId: 'e1' })).map((d) => d.id)).toEqual([ids[1], ids[0]]);
    expect((await store.decisions({ kind: 'desk' }))[0]).toMatchObject({ actor: 'desk', outcome: 'approved' });
    expect((await store.decisions({ since: '2026-11-23T09:00:00Z' })).map((d) => d.id)).toEqual([ids[2], ids[1]]);
    expect(await store.decisions({ limit: 1 })).toHaveLength(1);
    expect((await store.decisions({ eventId: 'e1', kind: 'extract' }))[0].detail).toEqual({ a: 1 });
  });

  it('records the whole path of an item: read, review gate, desk, text, delivery; drops with a reason', async () => {
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => clock });
    const { user } = await store.createUser('ExponentPushToken[a]', { timezone: 'Europe/Berlin' });
    await store.updateLocation(user.id, FRIEDRICHSHAIN.lat, FRIEDRICHSHAIN.lon);

    await pipeline.ingest([
      rss('a', 'Großbrand in Friedrichshain', 'In Friedrichshain brennt eine Lagerhalle. Fenster geschlossen halten.'),
      rss('b', 'Zeugenaufruf nach Einbruch in Steglitz', 'Bereits am vergangenen Wochenende wurde eingebrochen. Zeugen gesucht.'),
    ]);
    const [event] = await store.eventsByStatus('pending_review');
    const dropped = (await store.decisions({ kind: 'extract' })).find((d) => d.outcome === 'dropped')!;
    expect(dropped).toMatchObject({ sourceRef: 'rss:b', model: null, eventId: null, detail: { method: 'rules', reason: 'past incident or appeal' } });
    expect(await store.decisions({ eventId: event.id })).toMatchObject([
      { kind: 'extract', outcome: 'new_event', sourceRef: 'rss:a', detail: { method: 'rules', category: 'public_safety', confidence: 0.4 } },
      { kind: 'review_gate', outcome: 'pending_review' },
    ].reverse());
    const gate = (await store.decisions({ eventId: event.id, kind: 'review_gate' }))[0];
    expect(gate.detail.reason).toMatch(/confidence 0.4 below 0.6/);

    await pipeline.approve(event.id, { severity: 3 });
    const steps = (await store.decisions({ eventId: event.id })).reverse().map((d) => [d.kind, d.outcome]);
    expect(steps).toEqual([['extract', 'new_event'], ['review_gate', 'pending_review'], ['desk', 'approved'], ['compose', 'template'], ['rank', 'delivered']]);
    const desk = (await store.decisions({ eventId: event.id, kind: 'desk' }))[0];
    expect(desk).toMatchObject({ actor: 'desk', detail: { from: 'pending_review', severity: 3, severityWas: 4 } });
    const rank = (await store.decisions({ eventId: event.id, kind: 'rank' }))[0];
    expect(rank.detail).toMatchObject({ alerts: 1, byDelivery: { push: 1 } });
    expect((rank.detail.reasons as unknown[]).length).toBe(1);

    await pipeline.endEvent(event.id);
    expect((await store.decisions({ eventId: event.id })).slice(0, 2).map((d) => [d.kind, d.outcome])).toEqual([['rank', 'all_clear'], ['desk', 'ended']]);

    // Nothing in the log points at a person.
    const all = JSON.stringify(await store.decisions({}));
    expect(all).not.toContain(user.id);
    expect(all).not.toContain('ExponentPushToken');
    expect(all).not.toContain(String(FRIEDRICHSHAIN.lat));
  });

  it('names the model and prompt versions, and the verifier’s rejections', async () => {
    const pipeline = new Pipeline({ store, llm: new FakeModel(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => clock });
    await pipeline.ingest([rss('c', 'U5: Störung', 'Wegen einer Signalstörung ist die U5 in Friedrichshain unterbrochen. Ersatzverkehr mit Bussen.')]);
    const [ext] = await store.decisions({ kind: 'extract' });
    expect(ext).toMatchObject({ outcome: 'new_event', model: 'anthropic:test-model', promptVersion: EXTRACT_PROMPT_VERSION, detail: { method: 'model', modelOutput: { place: 'Friedrichshain' } } });
    expect((await store.decisions({ kind: 'review_gate' }))[0]).toMatchObject({ outcome: 'auto' });
    const [comp] = await store.decisions({ kind: 'compose' });
    expect(comp).toMatchObject({ outcome: 'ai_text', model: 'anthropic:test-model', promptVersion: COMPOSE_PROMPT_VERSION, detail: { attempts: 2 } });
    expect(JSON.stringify(comp.detail.rejected)).toMatch(/45.{0,4} is not in the source/);
    expect(EXTRACT_PROMPT_VERSION).toMatch(/^extract@[0-9a-f]{10}$/);
  });

  it('Alert Desk: JSON and CSV for admins only; reject and concierge alerts are logged', async () => {
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => clock });
    await pipeline.ingest([rss('d', 'Explosion in Reinickendorf', 'In einem Wohnhaus in Reinickendorf hat sich eine Explosion ereignet.')]);
    const [event] = await store.eventsByStatus('pending_review');
    const app = buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock });
    const h = { 'x-admin-token': 'secret' };
    await app.inject({ method: 'POST', url: `/admin/api/events/${event.id}/reject`, headers: h });
    await app.inject({ method: 'POST', url: '/admin/api/manual-alert', headers: h, payload: {
      category: 'transit', severity: 2, title: '=U5 unterbrochen', body: 'Ersatzverkehr mit Bussen', sourceName: 'Hey-Okay Redaktion',
      areaName: 'Mitte', lat: 52.53, lon: 13.39, radiusM: 1500,
    } });

    expect((await app.inject({ method: 'GET', url: '/admin/api/decisions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/api/decisions.csv' })).statusCode).toBe(401);
    const desk = (await app.inject({ method: 'GET', url: '/admin/api/decisions?kind=desk', headers: h })).json().decisions as Decision[];
    expect(desk.map((d) => d.outcome).sort()).toEqual(['manual_alert', 'rejected']);
    expect(desk.find((d) => d.outcome === 'rejected')).toMatchObject({ eventId: event.id, detail: { from: 'pending_review' } });
    const byEvent = (await app.inject({ method: 'GET', url: `/admin/api/decisions?eventId=${event.id}&limit=2`, headers: h })).json().decisions;
    expect(byEvent).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/admin/api/decisions?kind=nope', headers: h })).statusCode).toBe(400);

    const csv = await app.inject({ method: 'GET', url: '/admin/api/decisions.csv', headers: h });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/decisions-2026-11-23\.csv/);
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toBe('at,kind,actor,outcome,eventId,sourceRef,model,promptVersion,detail');
    expect(lines.length).toBe(1 + (await store.decisions({})).length);
  });
});

describe('decisionsCsv', () => {
  it('quotes every cell, doubles quotes, neutralises formulas', () => {
    const d: Decision = { id: 'x', at: '2026-11-23T09:00:00.000Z', kind: 'desk', actor: 'desk', eventId: 'e', sourceRef: null, model: null, promptVersion: null, outcome: '=SUM(A1)', detail: { t: 'say "hi"' } };
    const [, line] = decisionsCsv([d]).trim().split('\r\n');
    expect(line).toBe(`"2026-11-23T09:00:00.000Z","desk","desk","'=SUM(A1)","e","","","","{""t"":""say \\""hi\\""""}"`);
  });
});
