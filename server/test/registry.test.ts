import { afterEach, describe, expect, it } from 'vitest';
import { describeSource, parseCountries, sourceEnabled, sourceHealth, sourceReport } from '../src/sources/registry.js';
import { storeBackends } from './backends.js';
import type { Store } from '../src/store.js';

describe('source registry', () => {
  it('describes every kind of task key', () => {
    expect(describeSource('nina:dwd')).toMatchObject({ country: 'DE', official: true, fallback: 'dwd:direct' });
    expect(describeSource('nws:CA')).toMatchObject({ country: 'US', official: true });
    expect(describeSource('presseportal:feuerwehr-muenchen')).toMatchObject({ country: 'DE', official: false, category: 'fire' });
    expect(describeSource('owm:heat').country).toBe('*');
    expect(describeSource('push:queue').category).toBe('system');
  });

  it('COUNTRIES switches sources per country; place-following and system tasks always run', () => {
    expect(parseCountries(undefined)).toBeNull();
    expect(parseCountries(' de, at ')).toEqual(['DE', 'AT']);
    expect(() => parseCountries('DE,XX')).toThrow(/XX/);
    const de = parseCountries('DE');
    expect(sourceEnabled(describeSource('nina:mowas'), de)).toBe(true);
    expect(sourceEnabled(describeSource('nws:CA'), de)).toBe(false);
    expect(sourceEnabled(describeSource('owm:heat'), de)).toBe(true);
    expect(sourceEnabled(describeSource('push:receipts'), de)).toBe(true);
    expect(sourceEnabled(describeSource('nws:CA'), null)).toBe(true);
  });

  it('health: ok, failing, stale, waiting; the report lists problems first', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const s = (ok: string | null, err: string | null) => ({ ok: !!ok, running: false, lastOkAt: ok, lastErrorAt: err, lastDurationMs: 10 });
    expect(sourceHealth(s('2026-11-18T11:58:00Z', null), 120, now)).toBe('ok');
    expect(sourceHealth(s('2026-11-18T11:50:00Z', '2026-11-18T11:58:00Z'), 120, now)).toBe('failing');
    expect(sourceHealth(s('2026-11-18T11:40:00Z', null), 120, now)).toBe('stale');
    expect(sourceHealth(undefined, 120, now)).toBe('waiting');
    const r = sourceReport({ 'nina:mowas': s('2026-11-18T11:59:00Z', null), 'nws:CA': s(null, '2026-11-18T11:59:00Z') }, 120, now);
    expect(r.map((x) => [x.key, x.health])).toEqual([['nws:CA', 'failing'], ['nina:mowas', 'ok']]);
  });
});

for (const backend of storeBackends()) {
  describe(`source status store (${backend.name})`, () => {
    let store: Store;
    afterEach(async () => { await store.close(); });
    it('the worker writes, any machine reads; newer status replaces older', async () => {
      store = await backend.make();
      const a = { ok: true, running: true, lastOkAt: '2026-11-18T11:00:00.000Z', lastErrorAt: null, lastDurationMs: 120 };
      await store.saveSourceStatuses({ 'nina:mowas': a });
      await store.saveSourceStatuses({ 'nina:mowas': { ...a, lastOkAt: '2026-11-18T11:02:00.000Z' }, 'nws:CA': { ...a, ok: false, lastErrorAt: '2026-11-18T11:02:00.000Z' } });
      const got = await store.sourceStatuses();
      expect(got['nina:mowas'].lastOkAt).toBe('2026-11-18T11:02:00.000Z');
      expect(got['nina:mowas'].running).toBe(false); // a snapshot in the database is never "running"
      expect(got['nws:CA'].ok).toBe(false);
    });
  });
}

describe('Alert Desk sources API', () => {
  it('needs the admin token and shows what the worker saved', async () => {
    const { SqliteStore } = await import('../src/db.js');
    const { Pipeline } = await import('../src/pipeline/run.js');
    const { NoLLM } = await import('../src/llm.js');
    const { GazetteerGeocoder } = await import('../src/geocode.js');
    const { MemoryPushSender } = await import('../src/push.js');
    const { buildApi } = await import('../src/api.js');
    const { loadConfig } = await import('../src/config.js');
    const store = new SqliteStore();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const app = buildApi({ store, pipeline, adminToken: 'secret-admin', runIngest: async () => ({}) });
    await store.saveSourceStatuses({ 'nina:dwd': { ok: false, running: false, lastOkAt: null, lastErrorAt: new Date().toISOString(), lastDurationMs: 15000 } });
    expect((await app.inject({ url: '/admin/api/sources' })).statusCode).toBe(401);
    const r = await app.inject({ url: '/admin/api/sources', headers: { 'x-admin-token': 'secret-admin' } });
    expect(r.json().sources[0]).toMatchObject({ key: 'nina:dwd', health: 'failing', fallback: 'dwd:direct', country: 'DE' });
    expect((await app.inject({ url: '/admin' })).body).toContain('id="sources"');
    await app.close(); await store.close();
  });
});
