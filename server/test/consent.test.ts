import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/db.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { buildApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { stampConsent, DEFAULT_PREFS } from '../src/types.js';

describe('data-insights consent (PRD 5.5, Decision 25)', () => {
  it('is off by default; turning it on or off records when; unrelated saves keep the date', () => {
    const t1 = new Date('2026-11-18T10:00:00Z');
    expect(stampConsent(null, { ...DEFAULT_PREFS }, t1)).toMatchObject({ insightsConsent: false, insightsConsentAt: null });
    const on = stampConsent(null, { ...DEFAULT_PREFS, insightsConsent: true }, t1);
    expect(on).toMatchObject({ insightsConsent: true, insightsConsentAt: t1.toISOString() });
    const later = stampConsent(on, { ...on, dailyLimit: 5 }, new Date('2026-11-19T10:00:00Z'));
    expect(later.insightsConsentAt).toBe(t1.toISOString());
    const off = stampConsent(on, { ...on, insightsConsent: false }, new Date('2026-11-20T10:00:00Z'));
    expect(off).toMatchObject({ insightsConsent: false, insightsConsentAt: '2026-11-20T10:00:00.000Z' });
  });

  it('through the API: register with it, change it in settings', async () => {
    const store = new SqliteStore();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(), config: loadConfig({}) });
    const app = buildApi({ store, pipeline, adminToken: 'x', runIngest: async () => ({}) });
    const reg = (await app.inject({ method: 'POST', url: '/v1/devices', payload: { prefs: { insightsConsent: true } } })).json();
    expect(reg.prefs.insightsConsent).toBe(true);
    expect(typeof reg.prefs.insightsConsentAt).toBe('string');
    const auth = { authorization: `Bearer ${reg.token}` };
    const off = (await app.inject({ method: 'PUT', url: '/v1/me/prefs', headers: auth, payload: { insightsConsent: false } })).json();
    expect(off.prefs.insightsConsent).toBe(false);
    const plain = (await app.inject({ method: 'POST', url: '/v1/devices', payload: {} })).json();
    expect(plain.prefs).toMatchObject({ insightsConsent: false, insightsConsentAt: null, language: 'en' });
    await app.close(); await store.close();
  });
});
