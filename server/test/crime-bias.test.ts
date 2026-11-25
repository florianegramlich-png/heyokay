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
import { crimeBiasReport, districtOf, locate, quarterOf, quarterRange, type CrimeBiasReport } from '../src/bias-report.js';
import { HAMBURG_BEZIRKE } from '../src/data/hamburg-bezirke.js';
import { FRANKFURT_ORTSBEZIRKE } from '../src/data/frankfurt-ortsbezirke.js';
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

const berlin = (r: CrimeBiasReport) => r.cities.find((c) => c.key === 'berlin')!;
const hamburg = (r: CrimeBiasReport) => r.cities.find((c) => c.key === 'hamburg')!;
const frankfurt = (r: CrimeBiasReport) => r.cities.find((c) => c.key === 'frankfurt')!;
const FFM = {
  'Innenstadt I': [50.1109, 8.6821], // Römer
  'Innenstadt II': [50.1189, 8.6520], // Bockenheimer Warte
  'Innenstadt III': [50.1280, 8.6920], // Nordend
  'Bornheim/Ostend': [50.1300, 8.7110], // Bornheim Mitte
  Süd: [50.1000, 8.6830], // Sachsenhausen
  West: [50.1020, 8.5420], // Höchst
  'Mitte-West': [50.1300, 8.6100], // Rödelheim
  'Nord-West': [50.1640, 8.6440], // Heddernheim
  'Mitte-Nord': [50.1550, 8.6700], // Eschersheim
  'Nord-Ost': [50.1560, 8.6950], // Eckenheim
  Ost: [50.1170, 8.7550], // Fechenheim
  'Kalbach/Riedberg': [50.1750, 8.6350], // Riedberg
  'Nieder-Erlenbach': [50.2050, 8.7120],
  Harheim: [50.1830, 8.6880],
  'Nieder-Eschbach': [50.2000, 8.6650],
  'Bergen-Enkheim': [50.1580, 8.7600],
} as const;
const HH = {
  'Hamburg-Mitte': [53.5503, 9.9930], // Rathaus
  Altona: [53.5511, 9.9350], // Bahnhof Altona
  Eimsbüttel: [53.5750, 9.9530],
  'Hamburg-Nord': [53.5960, 10.0200], // Winterhude
  Wandsbek: [53.5720, 10.0700],
  Bergedorf: [53.4890, 10.2150],
  Harburg: [53.4600, 9.9800],
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
    expect(districtOf(50.9375, 6.9603)).toBeNull(); // Köln
    expect(districtOf(52.39, 13.06)).toBeNull(); // Potsdam
  });

  it('Hamburg: 7 districts, 1 980 285 residents, places in the right one, the enclave in Wandsbek is no district', () => {
    expect(HAMBURG_BEZIRKE).toHaveLength(7);
    expect(HAMBURG_BEZIRKE.reduce((a, b) => a + b.population, 0)).toBe(1_980_285);
    for (const [name, [lat, lon]] of Object.entries(HH)) {
      expect(locate(lat, lon), name).toEqual({ city: 'hamburg', code: HAMBURG_BEZIRKE.find((b) => b.name === name)!.code });
    }
    const hole = HAMBURG_BEZIRKE.find((b) => b.name === 'Wandsbek')!.holes![0];
    const [lon, lat] = [hole.reduce((a, p) => a + p[0], 0) / hole.length, hole.reduce((a, p) => a + p[1], 0) / hole.length];
    expect(locate(lat, lon)).toBeNull();
    expect(locate(53.5833, 9.6833)).toBeNull(); // Wedel, just outside
  });

  it('Frankfurt: 16 Ortsbezirke, 776 843 residents, places in the right one; the airport counts to Süd', () => {
    expect(FRANKFURT_ORTSBEZIRKE).toHaveLength(16);
    expect(FRANKFURT_ORTSBEZIRKE.reduce((a, b) => a + b.population, 0)).toBe(776_843);
    for (const [name, [lat, lon]] of Object.entries(FFM)) {
      expect(locate(lat, lon), name).toEqual({ city: 'frankfurt', code: FRANKFURT_ORTSBEZIRKE.find((b) => b.name === name)!.code });
    }
    expect(locate(50.0510, 8.5700)).toEqual({ city: 'frankfurt', code: FRANKFURT_ORTSBEZIRKE.find((b) => b.name === 'Süd')!.code }); // Terminal 1
    expect(locate(50.1050, 8.7650)).toBeNull(); // Offenbach, across the Main
    expect(locate(50.0820, 8.2400)).toBeNull(); // Wiesbaden
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
    events.push(ev([53.5503, 9.9930], { sources: [{ sourceName: 'Polizei Hamburg', externalId: 'h', title: 'T', official: false }] })); // Hamburg-Mitte
    events.push(ev([50.1020, 8.5420], { sources: [{ sourceName: 'Polizeipräsidium Frankfurt am Main', externalId: 'f', title: 'T', official: false }] })); // Höchst
    events.push(ev('Mitte', { startsAt: '2026-09-30T23:00:00.000Z' })); // previous quarter
    events.push(ev('Mitte', { category: 'transit' })); // not crime

    const r = crimeBiasReport(events, '2026-Q4');
    const d = Object.fromEntries(berlin(r).districts.map((x) => [x.name, x]));
    expect(berlin(r).total.released).toBe(15 + 1 + 10 * 5 + 1);
    expect(berlin(r).total.per100k).toBeCloseTo((67 / 3_917_196) * 1e5, 2);
    expect(r.outside).toBe(1);
    // Hamburg is compared with Hamburg only: one alert, in Mitte.
    expect(hamburg(r).total).toMatchObject({ population: 1_980_285, released: 1 });
    expect(hamburg(r).districts.find((x) => x.name === 'Hamburg-Mitte')).toMatchObject({ released: 1, flag: null, sources: [{ name: 'Polizei Hamburg', count: 1 }] });
    // Frankfurt likewise: one alert in West, compared with Frankfurt's own rate.
    expect(frankfurt(r).total).toMatchObject({ population: 776_843, released: 1 });
    const west = frankfurt(r).districts.find((x) => x.name === 'West')!;
    expect(west).toMatchObject({ released: 1, flag: null, sources: [{ name: 'Polizeipräsidium Frankfurt am Main', count: 1 }] });
    expect(west.ratio).toBeCloseTo(776_843 / 135_124, 2);
    expect(d.Mitte.ratio).toBeCloseTo((15 / 398505) / (67 / 3_917_196), 1);
    expect(d.Mitte).toMatchObject({ released: 15, flag: 'more' });
    expect(d.Mitte.ratio!).toBeGreaterThan(2);
    expect(d.Spandau).toMatchObject({ released: 1, flag: 'fewer' });
    expect(d.Lichtenberg.flag).toBeNull();
    expect(d.Neukölln).toMatchObject({ released: 6, rejected: 1, rejectedShare: 1 / 7 });
    expect(d.Neukölln.sources).toEqual([{ name: 'Polizei Berlin', count: 6 }, { name: 'Presseportal', count: 1 }]);
    expect(d.Pankow).toMatchObject({ released: 5, pendingReview: 1 });
    expect(berlin(r).total.rejectedShare).toBeCloseTo(1 / 68);
  });

  it('few alerts: nothing flagged, no division by zero', () => {
    const empty = crimeBiasReport([], '2026-Q4');
    for (const c of empty.cities) {
      expect(c.total).toMatchObject({ released: 0, per100k: 0, rejectedShare: null });
      expect(c.districts.every((d) => d.ratio === null && d.flag === null)).toBe(true);
    }
    const few = crimeBiasReport([ev('Mitte'), ev('Mitte'), ev('Spandau')], '2026-Q4');
    expect(berlin(few).districts.every((d) => d.flag === null)).toBe(true);
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
    expect(berlin(r).districts.find((d) => d.name === 'Mitte')!.released).toBe(2);
    expect(berlin(r).total.rejected).toBe(1);
    expect(r.cities.map((c: { key: string }) => c.key)).toEqual(['berlin', 'hamburg', 'frankfurt']);
    const q3 = (await app.inject({ method: 'GET', url: '/admin/api/crime-bias?quarter=2026-Q3', headers: h })).json();
    expect(berlin(q3).total.released).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/admin/api/crime-bias?quarter=Q3', headers: h })).statusCode).toBe(400);
    // No public route carries district numbers.
    expect(app.printRoutes()).not.toMatch(/v1[^\n]*bias/);
    expect(DESK_HTML).toContain('/admin/api/crime-bias');
  });
});
