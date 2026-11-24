import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import type { RiskEvent } from '../src/types.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';
import { buildApi } from '../src/api.js';
import { BERLIN_BEZIRKE } from '../src/data/berlin-bezirke.js';
import { crimeBiasReport, districtOf, quarterOf, quarterRange } from '../src/bias-report.js';
import { DESK_HTML } from '../src/desk.js';

// PRD 6.3: quarterly crime bias review by district; no area scores anywhere else.

const code = (name: string) => BERLIN_BEZIRKE.find((b) => b.name === name)!.code;
const PLACES = {
  Mitte: [52.5219, 13.4132], // Alexanderplatz
  Neukölln: [52.4867, 13.4246], // Hermannplatz
  Spandau: [52.5354, 13.1999], // Rathaus Spandau
  'Steglitz-Zehlendorf': [52.4340, 13.2590], // Zehlendorf
  'Marzahn-Hellersdorf': [52.5446, 13.5643],
  Reinickendorf: [52.5869, 13.3329],
  Lichtenberg: [52.5155, 13.4997],
  Pankow: [52.5693, 13.4010],
  'Charlottenburg-Wilmersdorf': [52.5167, 13.3041],
  'Treptow-Köpenick': [52.4454, 13.5747],
  'Tempelhof-Schöneberg': [52.4664, 13.3842],
  'Friedrichshain-Kreuzberg': [52.4986, 13.4034],
} as const;

let n = 0;
function ev(where: keyof typeof PLACES | [number, number], over: Partial<RiskEvent> = {}): RiskEvent {
  const [lat, lon] = typeof where === 'string' ? PLACES[where] : where;
  n++;
  return {
    id: `c${n}`, revision: 1, status: 'auto', category: 'crime', severity: 3, confidence: 0.9, official: false,
    title: 'Polizeieinsatz', summary: '', facts: '', areaName: '', lat, lon, radiusM: 500,
    startsAt: '2026-11-10T10:00:00.000Z', endsAt: null,
    sources: [{ sourceName: 'Polizei Berlin', externalId: `x${n}`, title: 'T', official: false }],
    copyTitle: null, copyBody: null, copyAction: null, copyIsTemplate: false,
    createdAt: '2026-11-10T10:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z', ...over,
  };
}

describe('districts and quarters', () => {
  it('12 districts with Berlin\'s population; well-known places land in the right one', () => {
    expect(BERLIN_BEZIRKE).toHaveLength(12);
    expect(BERLIN_BEZIRKE.reduce((a, b) => a + b.population, 0)).toBe(3_917_196);
    for (const [name, [lat, lon]] of Object.entries(PLACES)) expect(districtOf(lat, lon), name).toBe(code(name));
    expect(districtOf(48.1374, 11.5755)).toBeNull(); // München
    expect(districtOf(52.39, 13.06)).toBeNull(); // Potsdam
  });

  it('quarters', () => {
    expect(quarterRange('2026-Q4')).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' });
    expect(quarterRange('2027-Q1').to).toBe('2027-04-01T00:00:00.000Z');
    expect(quarterOf(new Date('2026-11-24T12:00:00Z'))).toBe('2026-Q4');
    expect(() => quarterRange('2026-Q5')).toThrow();
  });
});

describe('crimeBiasReport', () => {
  it('rates per 100 000 residents against Berlin; flags a district far above or below; rejections per district', () => {
    const events: RiskEvent[] = [];
    // 5 everywhere, 15 in Mitte: Mitte stands out, the rest are near Berlin's rate.
    for (const name of Object.keys(PLACES) as (keyof typeof PLACES)[]) for (let i = 0; i < (name === 'Mitte' ? 15 : name === 'Spandau' ? 1 : 5); i++) events.push(ev(name));
    events.push(ev('Neukölln', { status: 'rejected' }), ev('Neukölln', { status: 'approved', sources: [{ sourceName: 'Presseportal', externalId: 'p', title: 'T', official: false }, { sourceName: 'Polizei Berlin', externalId: 'q', title: 'T', official: false }] }));
    events.push(ev('Pankow', { status: 'pending_review' }));
    events.push(ev([48.1374, 11.5755])); // München
    events.push(ev('Mitte', { startsAt: '2026-09-30T23:00:00.000Z' })); // previous quarter
    events.push(ev('Mitte', { category: 'transit' })); // not crime

    const r = crimeBiasReport(events, '2026-Q4');
    const d = Object.fromEntries(r.districts.map((x) => [x.name, x]));
    expect(r.berlin.released).toBe(15 + 1 + 10 * 5 + 1);
    expect(r.berlin.per100k).toBeCloseTo((67 / 3_917_196) * 1e5, 2);
    expect(r.outsideBerlin).toBe(1);
    expect(d.Mitte).toMatchObject({ released: 15, flag: 'more' });
    expect(d.Mitte.ratio!).toBeGreaterThan(2);
    expect(d.Spandau).toMatchObject({ released: 1, flag: 'fewer' });
    expect(d.Lichtenberg.flag).toBeNull();
    expect(d.Neukölln).toMatchObject({ released: 6, rejected: 1, rejectedShare: 1 / 7 });
    expect(d.Neukölln.sources).toEqual([{ name: 'Polizei Berlin', count: 6 }, { name: 'Presseportal', count: 1 }]);
    expect(d.Pankow).toMatchObject({ released: 5, pendingReview: 1 });
    expect(r.berlin.rejectedShare).toBeCloseTo(1 / 68);
  });

  it('few alerts: nothing flagged, no division by zero', () => {
    const empty = crimeBiasReport([], '2026-Q4');
    expect(empty.berlin).toMatchObject({ released: 0, per100k: 0, rejectedShare: null });
    expect(empty.districts.every((d) => d.ratio === null && d.flag === null)).toBe(true);
    const few = crimeBiasReport([ev('Mitte'), ev('Mitte'), ev('Spandau')], '2026-Q4');
    expect(few.districts.every((d) => d.flag === null)).toBe(true);
  });
});

describe.each(storeBackends())('crime bias on the Alert Desk ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('the store picks crime events by start time; the desk endpoint defaults to the current quarter; desk only', async () => {
    await store.saveEvent(ev('Mitte'));
    await store.saveEvent(ev('Mitte', { startsAt: '2026-11-10T11:00:00+01:00' })); // offset, same quarter
    await store.saveEvent(ev('Neukölln', { status: 'rejected' }));
    await store.saveEvent(ev('Mitte', { startsAt: '2026-07-01T00:00:00.000Z' }));
    await store.saveEvent(ev('Mitte', { category: 'weather' }));
    const got = await store.eventsStartedBetween('crime', '2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    expect(got).toHaveLength(3);

    const clock = new Date('2026-11-24T08:00:00Z');
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push: new MemoryPushSender(),
      config: { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 }, now: () => clock });
    const app = buildApi({ store, pipeline, adminToken: 'secret', runIngest: async () => ({}), now: () => clock });
    const h = { 'x-admin-token': 'secret' };
    expect((await app.inject({ method: 'GET', url: '/admin/api/crime-bias' })).statusCode).toBe(401);
    const r = (await app.inject({ method: 'GET', url: '/admin/api/crime-bias', headers: h })).json();
    expect(r.quarter).toBe('2026-Q4');
    expect(r.districts.find((d: { name: string }) => d.name === 'Mitte').released).toBe(2);
    expect(r.berlin.rejected).toBe(1);
    const q3 = (await app.inject({ method: 'GET', url: '/admin/api/crime-bias?quarter=2026-Q3', headers: h })).json();
    expect(q3.berlin.released).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/admin/api/crime-bias?quarter=Q3', headers: h })).statusCode).toBe(400);
    // No public route carries district numbers.
    expect(app.printRoutes()).not.toMatch(/v1[^\n]*bias/);
    expect(DESK_HTML).toContain('/admin/api/crime-bias');
  });
});
