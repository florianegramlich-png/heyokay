import { BERLIN_BEZIRKE, BERLIN_POPULATION_AS_OF, type District } from './data/berlin-bezirke.js';
import { HAMBURG_BEZIRKE, HAMBURG_POPULATION_AS_OF } from './data/hamburg-bezirke.js';
import { FRANKFURT_ORTSBEZIRKE, FRANKFURT_POPULATION_AS_OF } from './data/frankfurt-ortsbezirke.js';
import { pointInRing } from './geo.js';
import type { RiskEvent } from './types.js';

/**
 * Quarterly crime bias review (PRD 6.3: "We report events, not dangerous neighbourhoods. No
 * area-level crime scores. Quarterly bias review of crime alerts by district.").
 *
 * For the team only (Alert Desk): within each city, are crime alerts spread over its districts
 * roughly like the people who live there, or do our sources (and the desk) cover some districts
 * far more or less than others? A high or low number points at the sources and the review, not at
 * the district. Districts are compared with their own city only. Never shown in the apps or on the web.
 */

/** A district is flagged when its rate is at least twice, or at most half, its city's... */
export const FLAG_RATIO = 2;
/** ...and it had at least this many alerts (fewer is noise). */
export const FLAG_MIN_EVENTS = 5;

export interface City {
  key: string;
  name: string;
  populationAsOf: string;
  districts: District[];
}

/** Cities with district outlines and populations. Add one per city in `data/`. */
export const BIAS_CITIES: City[] = [
  { key: 'berlin', name: 'Berlin', populationAsOf: BERLIN_POPULATION_AS_OF, districts: BERLIN_BEZIRKE },
  { key: 'hamburg', name: 'Hamburg', populationAsOf: HAMBURG_POPULATION_AS_OF, districts: HAMBURG_BEZIRKE },
  { key: 'frankfurt', name: 'Frankfurt am Main', populationAsOf: FRANKFURT_POPULATION_AS_OF, districts: FRANKFURT_ORTSBEZIRKE },
];

export interface DistrictRow {
  code: string;
  name: string;
  population: number;
  /** Released crime events (approved at the desk or released automatically). */
  released: number;
  /** Rejected at the Alert Desk. */
  rejected: number;
  pendingReview: number;
  /** Released per 100 000 residents in the quarter. */
  per100k: number;
  /** per100k divided by the city's per100k (1 = as expected from the population). */
  ratio: number | null;
  /** Rejected / (released + rejected): does the desk treat districts alike? */
  rejectedShare: number | null;
  /** Released events by publisher, most first. */
  sources: { name: string; count: number }[];
  flag: 'more' | 'fewer' | null;
}

export interface CityReport {
  key: string;
  name: string;
  populationAsOf: string;
  total: { population: number; released: number; rejected: number; per100k: number; rejectedShare: number | null };
  districts: DistrictRow[];
}

export interface CrimeBiasReport {
  quarter: string;
  from: string;
  to: string;
  cities: CityReport[];
  /** Crime events in no reviewed city (other cities): not part of this review yet. */
  outside: number;
  flagRule: string;
}

/** "2026-Q4" → [2026-10-01, 2027-01-01) in UTC. */
export function quarterRange(quarter: string): { from: string; to: string } {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) throw new Error(`bad quarter: ${quarter}`);
  const y = Number(m[1]);
  const q = Number(m[2]);
  return { from: new Date(Date.UTC(y, (q - 1) * 3, 1)).toISOString(), to: new Date(Date.UTC(y, q * 3, 1)).toISOString() };
}

/** The quarter a date falls in, e.g. "2026-Q4". */
export function quarterOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

const inDistrict = (lat: number, lon: number, d: District) =>
  d.rings.some((r) => pointInRing(lat, lon, r)) && !(d.holes ?? []).some((h) => pointInRing(lat, lon, h));

/** Which reviewed city and district an event's centre lies in, or null. */
export function locate(lat: number, lon: number): { city: string; code: string } | null {
  for (const c of BIAS_CITIES) {
    const d = c.districts.find((x) => inDistrict(lat, lon, x));
    if (d) return { city: c.key, code: d.code };
  }
  return null;
}

/** Which district (of any reviewed city) an event's centre lies in, or null. */
export function districtOf(lat: number, lon: number): string | null {
  return locate(lat, lon)?.code ?? null;
}

const released = (e: RiskEvent) => e.status === 'approved' || e.status === 'auto';
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function cityReport(city: City, byDistrict: Map<string, RiskEvent[]>): CityReport {
  const population = city.districts.reduce((a, b) => a + b.population, 0);
  const all = city.districts.flatMap((d) => byDistrict.get(d.code) ?? []);
  const cityReleased = all.filter(released).length;
  const cityRejected = all.filter((e) => e.status === 'rejected').length;
  const cityPer100k = (cityReleased / population) * 100_000;
  const districts = city.districts.map((b): DistrictRow => {
    const evs = byDistrict.get(b.code) ?? [];
    const rel = evs.filter(released);
    const rejected = evs.filter((e) => e.status === 'rejected').length;
    const per100k = (rel.length / b.population) * 100_000;
    const r = cityPer100k > 0 ? per100k / cityPer100k : null;
    const counts = new Map<string, number>();
    for (const e of rel) for (const name of new Set(e.sources.map((s) => s.sourceName))) counts.set(name, (counts.get(name) ?? 0) + 1);
    let flag: DistrictRow['flag'] = null;
    if (r != null && r >= FLAG_RATIO && rel.length >= FLAG_MIN_EVENTS) flag = 'more';
    else if (r != null && r <= 1 / FLAG_RATIO && cityReleased >= FLAG_MIN_EVENTS * city.districts.length) flag = 'fewer';
    return {
      code: b.code, name: b.name, population: b.population,
      released: rel.length, rejected, pendingReview: evs.filter((e) => e.status === 'pending_review').length,
      per100k: round(per100k), ratio: r == null ? null : round(r), rejectedShare: ratio(rejected, rel.length + rejected),
      sources: [...counts].map(([name, count]) => ({ name, count })).sort((a, z) => z.count - a.count || a.name.localeCompare(z.name)),
      flag,
    };
  });
  return {
    key: city.key, name: city.name, populationAsOf: city.populationAsOf,
    total: { population, released: cityReleased, rejected: cityRejected, per100k: round(cityPer100k), rejectedShare: ratio(cityRejected, cityReleased + cityRejected) },
    districts,
  };
}

export function crimeBiasReport(events: RiskEvent[], quarter: string): CrimeBiasReport {
  const { from, to } = quarterRange(quarter);
  const [f, t] = [Date.parse(from), Date.parse(to)];
  const crime = events.filter((e) => e.category === 'crime' && Date.parse(e.startsAt) >= f && Date.parse(e.startsAt) < t);
  const byDistrict = new Map<string, RiskEvent[]>();
  let outside = 0;
  for (const e of crime) {
    const at = locate(e.lat, e.lon);
    if (!at) { outside++; continue; }
    byDistrict.set(at.code, [...(byDistrict.get(at.code) ?? []), e]);
  }
  return {
    quarter, from, to,
    cities: BIAS_CITIES.map((c) => cityReport(c, byDistrict)),
    outside,
    flagRule: `Each district is compared with its own city. "more": at least ${FLAG_RATIO}× the city's rate and at least ${FLAG_MIN_EVENTS} alerts; "fewer": at most 1/${FLAG_RATIO} of the city's rate once the city has ${FLAG_MIN_EVENTS} alerts per district.`,
  };
}
