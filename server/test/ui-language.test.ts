import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/db.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { buildApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { contentLanguage } from '../src/types.js';

describe('UI languages (Tamil, 2026-11-19)', () => {
  it('Tamil is a UI language; alert copy and emails for it are written in English', () => {
    expect(contentLanguage('ta')).toBe('en');
    expect(contentLanguage('de')).toBe('de');
    expect(contentLanguage('en')).toBe('en');
    expect(contentLanguage(undefined)).toBe('en');
  });

  it('the API stores Tamil as the app language and rejects unknown ones', async () => {
    const store = new SqliteStore();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const app = buildApi({ store, pipeline, adminToken: 'x', runIngest: async () => ({}) });
    const reg = (await app.inject({ method: 'POST', url: '/v1/devices', payload: { prefs: { language: 'ta' } } })).json();
    expect(reg.prefs.language).toBe('ta');
    const auth = { authorization: `Bearer ${reg.token}` };
    const bad = await app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: auth, payload: { language: 'xx' } });
    expect(bad.statusCode).toBe(400);
    const back = (await app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: auth, payload: { language: 'en' } })).json();
    expect(back.prefs.language).toBe('en');
    await app.close(); await store.close();
  });
});
