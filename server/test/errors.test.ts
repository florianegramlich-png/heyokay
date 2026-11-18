import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { SqliteStore } from '../src/db.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { errorEntry, installProcessHandlers, type ErrorLogEntry } from '../src/errors.js';

function api() {
  const logged: ErrorLogEntry[] = [];
  const store = new SqliteStore();
  const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
  const app = buildApi({ store, pipeline, adminToken: 'secret-admin', runIngest: async () => ({}), errorSink: (e) => logged.push(e) });
  return { app, logged };
}

describe('server error reporting', () => {
  it('logs an unexpected route error as one structured entry without query or token, and returns 500', async () => {
    const { app, logged } = api();
    app.get('/boom/:id', async () => { throw new Error('kaputt'); });
    const res = await app.inject({ method: 'GET', url: '/boom/42?token=secret-admin', headers: { authorization: 'Bearer device-token' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'error', context: 'http', method: 'GET', route: '/boom/:id', name: 'Error', message: 'kaputt' });
    const line = JSON.stringify(logged[0]);
    expect(line).not.toContain('secret-admin');
    expect(line).not.toContain('device-token');
    // The concrete path (`/boom/42`) must not appear, only the route pattern. Checking for a bare "42"
    // was flaky: timestamps like 01:13:42 contain it too.
    expect(line).not.toContain('/boom/42');
    expect(line).not.toContain('token=');
  });

  it('keeps client errors (malformed JSON) as 400 and does not log them as errors', async () => {
    const { app, logged } = api();
    const res = await app.inject({ method: 'POST', url: '/v1/devices', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(res.statusCode).toBe(400);
    expect(logged).toHaveLength(0);
  });

  it('logs unhandled rejections and exits on uncaught exceptions', () => {
    const logged: ErrorLogEntry[] = [];
    const exits: number[] = [];
    // A stand-in for `process`, so the test runner's own handlers never see these events.
    const proc = new EventEmitter();
    const uninstall = installProcessHandlers((e) => logged.push(e), (c) => exits.push(c), proc as unknown as NodeJS.Process);
    proc.emit('unhandledRejection', new Error('vergessen'), Promise.resolve());
    proc.emit('uncaughtException', new Error('abgestürzt'));
    uninstall();
    expect(proc.listenerCount('unhandledRejection') + proc.listenerCount('uncaughtException')).toBe(0);
    expect(logged.map((e) => [e.level, e.context, e.message])).toEqual([
      ['error', 'unhandledRejection', 'vergessen'],
      ['fatal', 'uncaughtException', 'abgestürzt'],
    ]);
    expect(exits).toEqual([1]);
  });

  it('turns non-Error values into a readable entry', () => {
    expect(errorEntry('x', 'nur Text').message).toBe('nur Text');
    expect(errorEntry('x', { code: 7 }).message).toBe('{"code":7}');
  });
});
