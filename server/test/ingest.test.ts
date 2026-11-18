import { describe, it, expect } from 'vitest';
import { IngestScheduler, Mutex } from '../src/ingest.js';
import { buildApi } from '../src/api.js';
import { SqliteStore } from '../src/db.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { loadConfig } from '../src/config.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ingest scheduler', () => {
  it('a slow source does not hold up the others; it is skipped while still busy', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let fastRuns = 0;
    const s = new IngestScheduler([
      { key: 'presseportal:slow', run: async () => { await slow; return { done: true }; } },
      { key: 'nws:CA', run: async () => ({ run: ++fastRuns }) },
    ], () => {});

    const first = s.tick(); // the slow source keeps this tick open
    await tick();
    expect(fastRuns).toBe(1);
    const second = await s.tick(); // next poll: NWS runs again, the slow one is skipped
    expect(second).toEqual({ 'presseportal:slow': { skipped: 'still running' }, 'nws:CA': { run: 2 } });
    expect(s.snapshot()['presseportal:slow'].running).toBe(true);
    expect(s.snapshot()['nws:CA']).toMatchObject({ ok: true, running: false });

    release();
    expect((await first)['presseportal:slow']).toEqual({ done: true });
    expect(s.snapshot()['presseportal:slow']).toMatchObject({ ok: true, running: false });
  });

  it('records failures per source and keeps the others going', async () => {
    const errors: string[] = [];
    const s = new IngestScheduler([
      { key: 'nina:dwd', run: async () => { throw new Error('HTTP 503'); } },
      { key: 'nina:mowas', run: async () => ({ new: 0 }) },
    ], (key) => errors.push(key));
    const r = await s.tick();
    expect(r['nina:dwd']).toEqual({ error: 'HTTP 503' });
    expect(r['nina:mowas']).toEqual({ new: 0 });
    expect(errors).toEqual(['nina:dwd']);
    expect(s.snapshot()['nina:dwd']).toMatchObject({ ok: false, lastOkAt: null });
    expect(s.snapshot()['nina:dwd'].lastErrorAt).not.toBeNull();
  });

  it('the pipeline lock runs one step at a time, in order, even after a failure', async () => {
    const m = new Mutex();
    const log: string[] = [];
    const step = (name: string, fail = false) => m.run(async () => {
      log.push(`${name} start`); await tick(); log.push(`${name} end`);
      if (fail) throw new Error(name);
    });
    await Promise.allSettled([step('a'), step('b', true), step('c')]);
    expect(log).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
  });
});

describe('/health', () => {
  it('shows per-source status without error texts', async () => {
    const store = new SqliteStore();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const s = new IngestScheduler([{ key: 'nws:CA', run: async () => { throw new Error('secret detail https://x?token=abc'); } }], () => {});
    await s.tick();
    const app = buildApi({ store, pipeline, adminToken: 't', runIngest: () => s.tick(), ingestStatus: () => s.snapshot(), errorSink: () => {} });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sources: { 'nws:CA': { ok: false, running: false, lastOkAt: null } } });
    expect(res.body).not.toContain('secret');
  });
});
