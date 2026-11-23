import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import type { SourceItem } from '../src/types.js';
import { CaseFileSchema, resolveCase } from '../src/eval/cases.js';
import { firstSourceText } from '../src/eval/desk-export.js';

// PRD 6.4/6.5: Alert Desk decisions become labelled cases for the eval set.

const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };
let clock = new Date('2026-11-23T09:00:00+01:00');

function rss(id: string, title: string, body: string): SourceItem {
  return { source: 'rss', sourceName: 'Polizei Berlin', externalId: id, official: false, title, body, publishedAt: clock.toISOString(), language: 'de' };
}

describe.each(storeBackends())('Alert Desk → eval labels ($name)', (backend) => {
  let store: Store, pipeline: Pipeline;
  beforeEach(async () => {
    store = await backend.make();
    pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: cfg, now: () => clock });
  });
  afterEach(async () => { await store.close(); });

  it('exports approved (reviewer severity) and rejected events, not concierge alerts', async () => {
    await pipeline.ingest([
      rss('a', 'Bombenentschärfung in Mitte: Sperrkreis ab 10 Uhr', 'Bei Bauarbeiten in Mitte wurde ein Blindgänger gefunden. Anwohnende werden evakuiert.'),
      rss('b', 'Explosion in Reinickendorf', 'In einem Wohnhaus in Reinickendorf hat sich eine Explosion ereignet. Die Straße ist gesperrt.'),
    ]);
    const pending = await store.eventsByStatus('pending_review');
    expect(pending).toHaveLength(2);
    const bomb = pending.find((e) => e.facts.includes('Blindgänger'))!;
    const blast = pending.find((e) => e.facts.includes('Reinickendorf'))!;

    const app = buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock });
    const h = { 'x-admin-token': 'secret' };
    await app.inject({ method: 'POST', url: `/admin/api/events/${bomb.id}/approve`, headers: h, payload: { severity: 5 } });
    clock = new Date(clock.getTime() + 60_000);
    await app.inject({ method: 'POST', url: `/admin/api/events/${blast.id}/reject`, headers: h });
    await app.inject({ method: 'POST', url: '/admin/api/manual-alert', headers: h, payload: {
      category: 'transit', severity: 2, title: 'U5 unterbrochen', body: 'Ersatzverkehr mit Bussen', sourceName: 'Hey-Okay Redaktion',
      areaName: 'Mitte', lat: 52.53, lon: 13.39, radiusM: 1500,
    } });

    expect((await app.inject({ method: 'GET', url: '/admin/api/eval-export' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/admin/api/eval-export', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/desk-2026-11-23\.json/);
    const file = CaseFileSchema.parse(res.json());
    expect(file.cases.map((c) => [c.id, c.expect])).toEqual([
      [`desk-${bomb.id}`, { isEvent: true, category: bomb.category, severity: 5 }],
      [`desk-${blast.id}`, { isEvent: false }],
    ]);
    expect(file.cases[0]).toMatchObject({ origin: 'desk', item: { sourceName: 'Polizei Berlin', title: 'Bombenentschärfung in Mitte: Sperrkreis ab 10 Uhr' } });
    expect(file.cases[0].item!.body).toMatch(/Blindgänger/);
    // Ready to drop into server/eval/cases/: it runs through the same loader.
    expect(resolveCase(file.cases[0], 'desk', '.').item.title).toMatch(/Bombenentschärfung/);

    // Only decisions since a time.
    const later = await app.inject({ method: 'GET', url: `/admin/api/eval-export?since=${encodeURIComponent(new Date(clock.getTime() - 1000).toISOString())}`, headers: h });
    expect(later.json().cases.map((c: { id: string }) => c.id)).toEqual([`desk-${blast.id}`]);
    expect((await app.inject({ method: 'GET', url: '/admin/api/eval-export?since=yesterday', headers: h })).statusCode).toBe(400);
  });
});

describe('firstSourceText', () => {
  it('takes the first source from the facts', () => {
    const e = { facts: 'Titel A\nText A eins.\nText A zwei.\n---\nTitel B\nText B', sources: [], title: 'x' } as never;
    expect(firstSourceText(e)).toEqual({ title: 'Titel A', body: 'Text A eins.\nText A zwei.' });
  });
});
