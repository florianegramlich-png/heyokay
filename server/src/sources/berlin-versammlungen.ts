import { createHash } from 'node:crypto';
import type { SourceItem } from '../types.js';
import type { Geocoder } from '../geocode.js';
import { fetchWithTimeout } from '../http.js';
import { BERLIN_PLZ } from '../data/berlin-plz.js';
import { berlinDate } from './dwd-health.js';

/**
 * Registered assemblies in Berlin (Polizei Berlin, Versammlungsbehörde), from the JSON export of
 * its public list: https://www.berlin.de/polizei/service/versammlungsbehoerde/versammlungen-aufzuege/
 * Listed in Berlin's open-data register with the licence "other-closed / see website"; Flori decided
 * on 2026-11-22 to use it like the Polizei Berlin press releases: facts only, a link back, an off
 * switch (`BERLIN_VERSAMMLUNGEN_URL=off`).
 *
 * Only marches with a route ("Aufzüge") become alerts: they close streets, the ~40 stationary
 * vigils a day don't. Today and tomorrow (Berlin time). Topic `events`, feed only (rank.ts).
 * Neutral on purpose: we never show the assembly's topic or who registered it, only when and where.
 */
export const BERLIN_VERSAMMLUNGEN_URL = 'https://www.berlin.de/polizei/service/versammlungsbehoerde/versammlungen-aufzuege/index.php/index/all.json?q=';
const PAGE = 'https://www.berlin.de/polizei/service/versammlungsbehoerde/versammlungen-aufzuege/';
/** Places farther than this from a person aren't "near" (the event circle plus the match buffer). */
const DEFAULT_RADIUS_M = 1000;
/** A geocoder answer bigger than this (e.g. all of Berlin) is not a place. */
const MAX_GEOCODE_RADIUS_M = 3000;

export interface Assembly {
  datum: string;
  von: string;
  bis: string;
  plz: string;
  strasse_nr: string;
  aufzugsstrecke: string;
}

/** "23.11.2026" + "17:30" → ISO instant in Berlin time. */
export function berlinTime(datum: string, hm: string): string | null {
  const m = datum.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const t = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) return null;
  const [, d, mo, y] = m;
  // Find the UTC offset Berlin has on that day (CET +1, CEST +2).
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(t[1]), Number(t[2]));
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }).format(new Date(guess));
  const offsetH = (Number(parts) - Number(t[1]) + 24) % 24;
  return new Date(guess - offsetH * 3600_000).toISOString();
}

/** The route as a short list of places: "Savignyplatz – Kantstr. – Kaiser-Friedrich-Str.", without the police abbreviations. */
export function routeStops(route: string): string[] {
  const cleaned = route
    .replace(/^\s*(neue wegstrecke|neu)\s*:\s*/i, '')
    .replace(/\((?:[^()]*)\)/g, ' ') // "(AK)", "(vor dem Tor …)": notes, not places
    .replace(/\s+/g, ' ');
  const stops: string[] = [];
  for (const raw of cleaned.split(/\s*-\s*>\s*|\s+-\s+|\s+–\s+/)) {
    const s = raw
      .replace(/\(.*$/, '') // a note left open: "(von … GmbH"
      .replace(/\b(kehre|wenden|wendepunkt|zurück|runter bis|richtung \S+|nordseite|südseite|gehweg)\b/gi, ' ')
      .replace(/\s+/g, ' ').replace(/^[\s,-]+|[\s,-]+$/g, '');
    if (s.length < 3 || /^(ak|ek|zk|ap|ep)\b/i.test(s) || /\b(alle|stunden|wechsel|uhr)\b/i.test(s)) continue;
    if (stops[stops.length - 1] !== s && !stops.includes(s)) stops.push(s);
  }
  return stops;
}

const weekday = (iso: string) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(iso));

/** Marches with a route on `dates` (Berlin calendar dates, "2026-11-23"). */
export function marches(list: Assembly[], dates: string[]): Assembly[] {
  return list.filter((a) => {
    if (!a.aufzugsstrecke?.trim()) return false;
    const m = a.datum?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return !!m && dates.includes(`${m[3]}-${m[2]}-${m[1]}`);
  });
}

/** Stable id: the export numbers its rows, and the numbers shift when entries come and go. */
export function assemblyId(a: Assembly): string {
  return `berlin-versammlungen:${createHash('sha256').update(`${a.datum}|${a.von}|${a.bis}|${a.plz}|${a.strasse_nr}|${a.aufzugsstrecke}`).digest('hex').slice(0, 16)}`;
}

export async function toSourceItem(a: Assembly, geocoder?: Geocoder, now = new Date()): Promise<SourceItem | null> {
  const start = berlinTime(a.datum, a.von);
  const end = berlinTime(a.datum, a.bis);
  if (!start || !end) return null;
  const stops = routeStops(a.aufzugsstrecke);
  const startPlace = a.strasse_nr.trim() || stops[0];
  if (!startPlace) return null;
  // Where: the postcode when there is one, otherwise the start of the route, looked up.
  let where: { lat: number; lon: number; radiusM: number } | null = null;
  const plz = BERLIN_PLZ[a.plz.trim()];
  if (plz) where = { lat: plz[0], lon: plz[1], radiusM: Math.max(plz[2], DEFAULT_RADIUS_M) };
  else if (geocoder) {
    const hit = await geocoder.geocode(`${startPlace}, Berlin`);
    if (hit && hit.radiusM <= MAX_GEOCODE_RADIUS_M) where = { lat: hit.lat, lon: hit.lon, radiusM: Math.max(hit.radiusM, DEFAULT_RADIUS_M) };
  }
  if (!where) return null;
  // "Demo ab Savignyplatz, 17:30–19:00": the place is clipped so the title stays within 50.
  const room = 50 - `Demo ab , ${a.von}–${a.bis}`.length;
  const clipped = startPlace.length <= room ? startPlace : `${startPlace.slice(0, room - 1).trimEnd()}…`;
  const route = stops.slice(0, 5).join(' – ').replace(/\.$/, '') + (stops.length > 5 ? ' …' : '.');
  return {
    source: 'berlin-versammlungen',
    sourceName: 'Polizei Berlin · Versammlungen',
    externalId: assemblyId(a),
    official: true,
    structured: true,
    hazard: 'assembly',
    category: 'events',
    language: 'de',
    country: 'DE',
    title: `Demo ab ${clipped}, ${a.von}–${a.bis}`,
    body: `Angemeldeter Aufzug am ${weekday(start)}, ${a.von}–${a.bis} Uhr: ${route} Straßen können zeitweise gesperrt sein.`,
    url: PAGE,
    // Listed now; it begins at `onsetAt` ("coming up" until then).
    publishedAt: new Date(Math.min(Date.parse(start), now.getTime())).toISOString(),
    onsetAt: start,
    expiresAt: end,
    ...where,
    areaName: startPlace,
    officialSeverity: 1,
  };
}

/** New marches today and tomorrow. */
export async function fetchAssemblies(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: (url: string) => Promise<string> = async (url) => {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'HeyOkay/0.1 (safety alerts; contact via app)' } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.text();
  },
  opts: { now?: Date; url?: string; geocoder?: Geocoder } = {},
): Promise<SourceItem[]> {
  const now = opts.now ?? new Date();
  let json: { index?: Assembly[] };
  try { json = JSON.parse(await get(opts.url ?? BERLIN_VERSAMMLUNGEN_URL)); } catch { throw new Error('Berlin assemblies: answer is not JSON'); }
  if (!Array.isArray(json?.index)) throw new Error('Berlin assemblies: unexpected format'); // a changed export must fail, not look like "no assemblies"
  const dates = [berlinDate(now), berlinDate(new Date(now.getTime() + 86_400_000))];
  const out: SourceItem[] = [];
  for (const a of marches(json.index, dates)) {
    const end = berlinTime(a.datum, a.bis);
    if (end && Date.parse(end) <= now.getTime()) continue; // already over
    if (!(await isNew(assemblyId(a)))) continue; // before the lookup: no geocoding for known marches
    const item = await toSourceItem(a, opts.geocoder, now);
    if (item) out.push(item);
  }
  return out;
}
