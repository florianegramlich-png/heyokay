import { BERLIN_BEZIRKE, BERLIN_POPULATION_AS_OF } from './data/berlin-bezirke.js';
import { pointInRing } from './geo.js';
import type { RiskEvent } from './types.js';

/**
 * Quarterly crime bias review (PRD 6.3: "We report events, not dangerous neighbourhoods. No
 * area-level crime scores. Quarterly bias review of crime alerts by district.").
 *
 * For the team only (Alert Desk): are crime alerts spread over Berlin's districts roughly like
 * the people who live there, or do our sources (and the desk) cover some districts far more or
 * less than others? A high or low number points at the sources and the review, not at the
 * district. Never shown in the apps or on the web.
 */

/** A district is flagged when its rate is at least twice, or at most half, Berlin's... */
export const FLAG_RATIO = 2;
/** ...and it had at least this many alerts (fewer is noise). */
export const FLAG_MIN_EVENTS = 5;

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
  /** per100k divided by Berlin's per100k (1 = as expected from the population). */
  ratio: number | null;
  /** Rejected / (released + rejected): does the desk treat districts alike? */
  rejectedShare: number | null;
  /** Released events by publisher, most first. */
  sources: { name: string; count: number }[];
  flag: 'more' | 'fewer' | null;
}

export interface CrimeBiasReport {
  quarter: string;
  from: string;
  to: string;
  populationAsOf: string;
  berlin: { population: number; released: number; rejected: number; per100k: number; rejectedShare: number | null };
  districts: DistrictRow[];
  /** Crime events outside Berlin (other cities): not part of this review yet. */
  outsideBerlin: number;
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

/** Which Berlin district an event's centre lies in, or null. */
export function districtOf(lat: number, lon: number): string | null {
  return BERLIN_BEZIRKE.find((b) => b.rings.some((r) => pointInRing(lat, lon, r)))?.code ?? null;
}

const released = (e: RiskEvent) => e.status === 'approved' || e.status === 'auto';
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function crimeBiasReport(events: RiskEvent[], quarter: string): CrimeBiasReport {
  const { from, to } = quarterRange(quarter);
  const [f, t] = [Date.parse(from), Date.parse(to)];
  const crime = events.filter((e) => e.category === 'crime' && Date.parse(e.startsAt) >= f && Date.parse(e.startsAt) < t);
  const byDistrict = new Map<string, RiskEvent[]>();
  let outsideBerlin = 0;
  for (const e of crime) {
    const code = districtOf(e.lat, e.lon);
    if (!code) { outsideBerlin++; continue; }
    byDistrict.set(code, [...(byDistrict.get(code) ?? []), e]);
  }
  const population = BERLIN_BEZIRKE.reduce((a, b) => a + b.population, 0);
  const all = [...byDistrict.values()].flat();
  const berlinReleased = all.filter(released).length;
  const berlinRejected = all.filter((e) => e.status === 'rejected').length;
  const berlinPer100k = (berlinReleased / population) * 100_000;

  const districts = BERLIN_BEZIRKE.map((b): DistrictRow => {
    const evs = byDistrict.get(b.code) ?? [];
    const rel = evs.filter(released);
    const rejected = evs.filter((e) => e.status === 'rejected').length;
    const per100k = (rel.length / b.population) * 100_000;
    const r = berlinPer100k > 0 ? per100k / berlinPer100k : null;
    const counts = new Map<string, number>();
    for (const e of rel) for (const name of new Set(e.sources.map((s) => s.sourceName))) counts.set(name, (counts.get(name) ?? 0) + 1);
    let flag: DistrictRow['flag'] = null;
    if (r != null && r >= FLAG_RATIO && rel.length >= FLAG_MIN_EVENTS) flag = 'more';
    else if (r != null && r <= 1 / FLAG_RATIO && berlinReleased >= FLAG_MIN_EVENTS * BERLIN_BEZIRKE.length) flag = 'fewer';
    return {
      code: b.code, name: b.name, population: b.population,
      released: rel.length, rejected, pendingReview: evs.filter((e) => e.status === 'pending_review').length,
      per100k: round(per100k), ratio: r == null ? null : round(r), rejectedShare: ratio(rejected, rel.length + rejected),
      sources: [...counts].map(([name, count]) => ({ name, count })).sort((a, z) => z.count - a.count || a.name.localeCompare(z.name)),
      flag,
    };
  });
  return {
    quarter, from, to, populationAsOf: BERLIN_POPULATION_AS_OF,
    berlin: { population, released: berlinReleased, rejected: berlinRejected, per100k: round(berlinPer100k), rejectedShare: ratio(berlinRejected, berlinReleased + berlinRejected) },
    districts,
    outsideBerlin,
    flagRule: `"more": at least ${FLAG_RATIO}× Berlin's rate and at least ${FLAG_MIN_EVENTS} alerts; "fewer": at most 1/${FLAG_RATIO} of Berlin's rate once Berlin has ${FLAG_MIN_EVENTS * BERLIN_BEZIRKE.length}+ alerts.`,
  };
}
