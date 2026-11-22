import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CPSC_URL, OPENFDA_URL, cpscReason, cpscToSourceItem, distribution, fdaToSourceItem, fetchCpscRecalls, fetchFdaRecalls, parseFda, productName,
} from '../src/sources/us-recalls.js';
import { US_STATES } from '../src/data/us-states.js';
import { distanceToAreasM } from '../src/geo.js';
import { describeSource } from '../src/sources/registry.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { storeBackends } from './backends.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { Pipeline } from '../src/pipeline/run.js';

const fixture = (n: string) => readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8');
const FOOD = fixture('openfda-food.json');
const DRUG = fixture('openfda-drug.json');
const CPSC = fixture('cpsc-recalls.json');
const NOW = new Date('2026-11-22T10:00:00Z');
const SF = { lat: 37.77, lon: -122.42 };
const NYC = { lat: 40.71, lon: -74.01 };
const BERLIN = { lat: 52.52, lon: 13.405 };
const inside = (areas: [number, number][][], p: { lat: number; lon: number }) => distanceToAreasM(p.lat, p.lon, areas) === 0;
const fakeGet = (over: Partial<Record<'food' | 'drug' | 'cpsc', { status: number; text: string }>> = {}) => {
  const urls: string[] = [];
  const get = async (u: string) => {
    urls.push(u);
    const kind = u.includes('/food/') ? 'food' : u.includes('/drug/') ? 'drug' : 'cpsc';
    return over[kind] ?? { status: 200, text: kind === 'food' ? FOOD : kind === 'drug' ? DRUG : CPSC };
  };
  return { get, urls };
};

describe('US recalls: reading where a product was sold', () => {
  it('state codes, state names, nationwide and online; nothing for "sold to 16 customers" or Puerto Rico', () => {
    expect(distribution('Distributors located in CT, MA, MD, NJ, NY, PA, and VA. Product may be further distributed.')).toEqual({ nationwide: false, states: ['CT', 'MA', 'MD', 'NJ', 'NY', 'PA', 'VA'] });
    expect(distribution('Arizona, Colorado, Illinois, West Virginia and Arkansas.')).toEqual({ nationwide: false, states: ['AR', 'AZ', 'CO', 'IL', 'WV'] });
    expect(distribution('TX only')).toEqual({ nationwide: false, states: ['TX'] });
    expect(distribution('Shipped to a warehouse in Washington, D.C.')).toEqual({ nationwide: false, states: ['DC'] });
    for (const t of ['Recalled product was distributed nationwide.', 'U.S. Nationwide', 'Nationwide in the USA.', 'Product was distributed to 9 different distribution centers across the country.', "The product was sold to consumers through the firm's website."]) {
      expect(distribution(t), t).toEqual({ nationwide: true, states: [] });
    }
    expect(distribution('Nalpac sold to approximately 16 customers, some of whom have multiple stores.')).toEqual({ nationwide: false, states: [] });
    expect(distribution('All customers located in Puerto Rico')).toEqual({ nationwide: false, states: [] });
    // Capital words inside a sentence are not state codes.
    expect(distribution('Product INCLUDING ORGANIC milk, sold in OR')).toEqual({ nationwide: false, states: ['OR'] });
  });

  it('short product names and calm CPSC reasons', () => {
    expect(productName('Raw milk cheddar cheese packed in vacuum sealed clear plastic with a white, red and green label')).toBe('Raw milk cheddar cheese');
    expect(productName('WinCo Foods Hoagie Rolls, 6 count, UPC 0-70552-50421-1')).toBe('WinCo Foods Hoagie Rolls');
    expect(productName('A very long product description that goes on and on without any punctuation at all')).toBe('A very long product description that…');
    expect(cpscReason('Kidsview Recalls Infant Bouncers Due to Risk of Collapse and Impact Injury to Infants')).toBe('Collapse and impact injury to infants');
    expect(cpscReason('CHE-US Recalls Magnetic Robot Toys Due to Risk of Serious Injury or Death from Magnet Ingestion; Violate Mandatory Standard for Toys')).toBe('Magnet ingestion');
    expect(cpscReason('Gourmia Recalls 9-Slice Digital Air Fryer Ovens Due to Burn Hazard')).toBe('Burn hazard');
    expect(cpscReason('Some Product Recall')).toBeNull();
  });

  it('state outlines: 50 states and DC, each containing its capital', () => {
    expect(Object.keys(US_STATES)).toHaveLength(51);
    const capitals: Record<string, [number, number]> = {
      AL: [32.38, -86.3], AK: [58.3, -134.42], AZ: [33.45, -112.07], AR: [34.75, -92.29], CA: [38.58, -121.49], CO: [39.74, -104.99],
      CT: [41.76, -72.68], DE: [39.16, -75.52], DC: [38.9, -77.03], FL: [30.44, -84.28], GA: [33.75, -84.39], HI: [21.31, -157.86],
      ID: [43.62, -116.2], IL: [39.8, -89.65], IN: [39.77, -86.16], IA: [41.59, -93.62], KS: [39.05, -95.68], KY: [38.2, -84.87],
      LA: [30.45, -91.19], ME: [44.31, -69.78], MD: [38.98, -76.49], MA: [42.36, -71.06], MI: [42.73, -84.56], MN: [44.95, -93.09],
      MS: [32.3, -90.18], MO: [38.58, -92.17], MT: [46.59, -112.04], NE: [40.81, -96.7], NV: [39.16, -119.77], NH: [43.21, -71.54],
      NJ: [40.22, -74.76], NM: [35.69, -105.94], NY: [42.65, -73.76], NC: [35.78, -78.64], ND: [46.81, -100.78], OH: [39.96, -83.0],
      OK: [35.47, -97.52], OR: [44.94, -123.03], PA: [40.27, -76.88], RI: [41.82, -71.41], SC: [34.0, -81.03], SD: [44.37, -100.35],
      TN: [36.16, -86.78], TX: [30.27, -97.74], UT: [40.76, -111.89], VT: [44.26, -72.58], VA: [37.54, -77.44], WA: [47.04, -122.9],
      WV: [38.35, -81.63], WI: [43.07, -89.4], WY: [41.14, -104.82],
    };
    for (const [code, [lat, lon]] of Object.entries(capitals)) expect(inside(US_STATES[code].rings, { lat, lon }), code).toBe(true);
    // Coastal cities and islands the 1:50m coastline alone would miss.
    for (const [code, lat, lon] of [['NY', 40.71, -74.01], ['NY', 40.58, -74.15], ['FL', 25.76, -80.19], ['FL', 24.56, -81.78], ['TX', 29.3, -94.8], ['MA', 41.28, -70.1]] as const) {
      expect(inside(US_STATES[code].rings, { lat, lon }), `${code} ${lat},${lon}`).toBe(true);
    }
    expect(inside(US_STATES.CA.rings, NYC)).toBe(false);
    expect(inside(US_STATES.VA.rings, { lat: 38.35, lon: -81.63 })).toBe(false); // Charleston, WV
  });
});

describe('FDA enforcement reports (openFDA)', () => {
  it('one recall per event; food class I/II, drugs class I and over-the-counter class II', () => {
    const food = parseFda(JSON.parse(FOOD), 'food');
    const ids = food.map((r) => r.id);
    expect(ids).toContain('100137'); // raw milk cheddar, class I
    expect(ids).toContain('99783'); // class II
    expect(ids).not.toContain('100223'); // class III
    expect(ids).not.toContain('100248'); // not yet classified
    expect(ids.filter((id) => id === '100088')).toHaveLength(1); // 3 hummus records, one recall
    expect(food.find((r) => r.id === '100088')).toMatchObject({ products: 3, states: ['CT', 'MA'], codes: null, classification: 'Class I' });
    expect(food.find((r) => r.id === '100137')).toEqual({
      id: '100137', kind: 'food', classification: 'Class I', firm: 'Family Farmstead Dairy', product: 'Raw milk cheddar cheese', products: 1,
      reason: 'Potential contamination with E. coli (pathogenic non-O157 STEC).', codes: 'No lot code, Best By JUL 22 27', reportDate: '20261111',
      nationwide: false, states: ['CT', 'MA', 'MD', 'NJ', 'NY', 'PA', 'VA'],
    });
    const drugs = parseFda(JSON.parse(DRUG), 'drug').map((r) => [r.id, r.product]);
    expect(drugs).toEqual([['100072', 'Argatroban Injection'], ['100159', 'Artificial Tears Lubricant Eye Drops']]); // compounding vials (class II) and class III left out
    expect(parseFda(JSON.parse(FOOD), 'food', '20261108').every((r) => r.reportDate >= '20261108')).toBe(true);
    expect(parseFda({}, 'food')).toEqual([]);
  });

  it('becomes a calm English recall over the states it names, or nowhere', () => {
    const food = parseFda(JSON.parse(FOOD), 'food');
    const cheese = fdaToSourceItem(food.find((r) => r.id === '100137')!)!;
    expect(cheese).toMatchObject({
      source: 'fda', sourceName: 'FDA · Food recalls', externalId: 'fda:food:100137', official: true, structured: true,
      category: 'recall', hazard: 'recall', language: 'en', country: 'US', officialSeverity: 1,
      title: 'Recall: Raw milk cheddar cheese', areaName: '7 US states', publishedAt: '2026-11-11T12:00:00.000Z', expiresAt: '2026-11-25T12:00:00.000Z',
    });
    expect(cheese.body).toBe('Reason: Potential contamination with E. coli (pathogenic non-O157 STEC). Sold in: CT, MA, MD, NJ, NY, PA, VA. No lot code, Best By JUL 22 27. Company: Family Farmstead Dairy.');
    expect(inside(cheese.areas!, NYC)).toBe(true);
    expect(inside(cheese.areas!, SF)).toBe(false);
    const hummus = fdaToSourceItem(food.find((r) => r.id === '100088')!)!;
    expect(hummus).toMatchObject({ areaName: 'Connecticut, Massachusetts' });
    expect(hummus.body).toContain('3 products.');
    const seitan = fdaToSourceItem(food.find((r) => r.id === '100127')!)!; // "across the country"
    expect(seitan).toMatchObject({ areaName: 'United States' });
    expect(seitan.body).toContain('Sold in: nationwide.');
    for (const p of [SF, NYC, { lat: 61.2, lon: -149.9 } /* Anchorage */, { lat: 21.31, lon: -157.86 } /* Honolulu */]) expect(inside(seitan.areas!, p)).toBe(true);
    expect(inside(seitan.areas!, BERLIN)).toBe(false);
    const broccoli = fdaToSourceItem(food.find((r) => r.id === '99993')!)!;
    expect(broccoli.body).toContain('Sold in: 48 states.');
    expect(fdaToSourceItem(food.find((r) => r.id === '100122')!)).toBeNull(); // Puerto Rico only
    expect(fdaToSourceItem(food.find((r) => r.id === '98760')!)).toBeNull(); // "16 customers"
  });

  it('asks for the last 14 days of reports; no records is "no recalls", a changed answer fails', async () => {
    const { get, urls } = fakeGet();
    const items = await fetchFdaRecalls((id) => id !== 'fda:food:100193', get, { now: NOW });
    expect(urls).toEqual([
      `${OPENFDA_URL}/food/enforcement.json?search=report_date:[20261108+TO+20261122]&limit=1000`,
      `${OPENFDA_URL}/drug/enforcement.json?search=report_date:[20261108+TO+20261122]&limit=1000`,
    ]);
    expect(items.map((i) => i.externalId)).toEqual([
      'fda:food:100137', 'fda:food:100089', 'fda:food:99783', 'fda:food:100138', 'fda:food:98489', 'fda:food:100127', 'fda:drug:100159',
    ]);
    const notFound = { status: 404, text: '{"error":{"code":"NOT_FOUND","message":"No matches found!"}}' };
    expect(await fetchFdaRecalls(() => true, fakeGet({ food: notFound, drug: notFound }).get, { now: NOW })).toEqual([]);
    await expect(fetchFdaRecalls(() => true, fakeGet({ food: { status: 500, text: 'oops' } }).get, { now: NOW })).rejects.toThrow(/HTTP 500/);
    await expect(fetchFdaRecalls(() => true, fakeGet({ food: { status: 200, text: '<html>maintenance</html>' } }).get, { now: NOW })).rejects.toThrow(/not JSON/);
    await expect(fetchFdaRecalls(() => true, fakeGet({ food: { status: 200, text: '{"meta":{}}' } }).get, { now: NOW })).rejects.toThrow(/no results/);
  });
});

describe('CPSC product recalls', () => {
  it('nationwide consumer-product recalls from the last 7 days, with remedy and units', async () => {
    const { get, urls } = fakeGet();
    const items = await fetchCpscRecalls(() => true, get, { now: NOW });
    expect(urls).toEqual([`${CPSC_URL}?format=json&RecallDateStart=2026-11-15`]);
    expect(items.map((i) => i.title)).toEqual([
      'Recall: CHE-US Magnetic Robot Toys', 'Recall: Cipton Bike Helmets', 'Recall: Fidlock Hermetic Dry Bags', 'Recall: Custom Leather Craft (CLC) Lighted…',
    ]); // the 12 November recall is older than 7 days
    expect(items[0]).toMatchObject({
      source: 'cpsc', sourceName: 'CPSC · Product recalls', externalId: 'cpsc:27096', official: true, structured: true, category: 'recall', hazard: 'recall',
      language: 'en', country: 'US', officialSeverity: 1, areaName: 'United States', publishedAt: '2026-11-19T12:00:00.000Z', expiresAt: '2026-12-03T12:00:00.000Z',
      body: 'Reason: Magnet ingestion. Sold in: nationwide. Remedy: refund. Units: about 101,282.',
    });
    expect(items[0].url).toMatch(/^https:\/\/cpsc\.gov\/Recalls\/2027\/CHE-US-Recalls-Magnetic-Robot-Toys/);
    expect(items[2].body).toContain('Remedy: refund or replace.');
    expect(cpscToSourceItem({ Title: 'x' })).toBeNull();
    expect(await fetchCpscRecalls(() => false, get, { now: NOW })).toEqual([]);
    await expect(fetchCpscRecalls(() => true, fakeGet({ cpsc: { status: 200, text: '{"error":"x"}' } }).get, { now: NOW })).rejects.toThrow(/not a list/);
    await expect(fetchCpscRecalls(() => true, fakeGet({ cpsc: { status: 503, text: '' } }).get, { now: NOW })).rejects.toThrow(/HTTP 503/);
  });

  it('settings and registry: both on by default, "off" switches them off, US only', () => {
    expect(loadConfig({})).toMatchObject({ fdaRecalls: OPENFDA_URL, cpscRecalls: CPSC_URL });
    expect(loadConfig({ FDA_RECALLS_URL: 'off', CPSC_RECALLS_URL: 'off' })).toMatchObject({ fdaRecalls: null, cpscRecalls: null });
    expect(describeSource('fda:US')).toMatchObject({ name: 'FDA · Food and drug recalls', country: 'US', official: true, category: 'recall' });
    expect(describeSource('cpsc:US')).toMatchObject({ name: 'CPSC · Product recalls', country: 'US', official: true, category: 'recall' });
  });
});

describe.each(storeBackends())('US recalls end to end ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  it('hoagie rolls sold in the West reach San Francisco, the cheese reaches New York, never a push', async () => {
    const push = new MemoryPushSender();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: loadConfig({}), now: () => NOW });
    const sf = (await store.createUser('ExponentPushToken[sf]')).user;
    await store.updateLocation(sf.id, SF.lat, SF.lon);
    const ny = (await store.createUser('ExponentPushToken[ny]')).user;
    await store.updateLocation(ny.id, NYC.lat, NYC.lon);

    const items = (await fetchFdaRecalls(() => true, fakeGet().get, { now: NOW })).filter((i) => i.externalId === 'fda:food:100193' || i.externalId === 'fda:food:100137');
    expect(await pipeline.ingest(items)).toMatchObject({ eventsCreated: 2, sentToReview: 0, alertsCreated: 2 });
    const [west] = await store.alertsForUser(sf.id);
    expect(west).toMatchObject({ category: 'recall', delivery: 'feed', title: 'Recall: WinCo Foods Hoagie Rolls' });
    expect(west.action).toMatch(/^Don't use the product/);
    const [east] = await store.alertsForUser(ny.id);
    expect(east).toMatchObject({ category: 'recall', delivery: 'feed', title: 'Recall: Raw milk cheddar cheese' });
    expect(await store.alertsForUser(sf.id)).toHaveLength(1);
    expect(push.outbox).toEqual([]);
  });
});
