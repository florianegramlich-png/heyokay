import type { Severity, SourceItem } from '../types.js';
import { countryNear } from './usgs.js';
import { fetchWithTimeout } from '../http.js';

/**
 * River water levels in Germany from PEGELONLINE, the federal waterways agency (WSV):
 * https://www.pegelonline.wsv.de/webservice/dokuRestapi — public, no key, licence DL-DE/Zero-2.0.
 *
 * One request returns every gauge with its latest reading (every 15 minutes) and two states the
 * agency computes against the gauge's own reference levels:
 *   stateMnwMhw  low | normal | high — high = above the mean flood level (MHW)
 *   stateNswHsw  normal | high       — high = above the highest level ships may sail at (HSW)
 *
 * These are measurements, not warnings, so we stay calm: above HSW → "high water" in the feed
 * (severity 1); above MHW → "flooding" (severity 2, may push). Anything more serious comes from
 * the Länder flood centres as official warnings (NINA · Hochwasserportal), which stay the
 * authority. When the level falls back, the alert gets an all-clear.
 */
export const PEGELONLINE_URL =
  'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?includeTimeseries=true&includeCurrentMeasurement=true&timeseries=W';

/** People near the river around the gauge. A gauge stands for a stretch of river, so this is generous. */
export const GAUGE_RADIUS_M = 5_000;
/** Readings older than this say nothing about now (gauge offline). */
const MAX_AGE_MS = 3 * 3600_000;

export interface PegelStation {
  uuid: string;
  number?: string;
  shortname: string;
  longname?: string;
  latitude?: number;
  longitude?: number;
  water?: { shortname?: string; longname?: string };
  timeseries?: Array<{
    shortname: string;
    unit?: string;
    currentMeasurement?: { timestamp: string; value: number; stateMnwMhw?: string; stateNswHsw?: string };
  }>;
}

const SMALL = new Set(['am', 'an', 'der', 'die', 'im', 'in', 'bei', 'ob', 'unter', 'über', 'a.', 'i.']);
/** "FRANKFURT AM MAIN" → "Frankfurt am Main", "TEMPLINER GEWÄSSER" → "Templiner Gewässer". */
export function niceName(raw: string): string {
  return raw.toLowerCase().split(/(\s+|-)/).map((w, i) =>
    i > 0 && SMALL.has(w) ? w : /^(up|op)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
  ).join('');
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const id = (uuid: string, level: Severity, d: Date) => `pegelonline:${uuid}:${level}:${day(d)}`;
/** Every id a running flood at this gauge can have (today and yesterday, both levels). */
const familyIds = (uuid: string, now: Date) => {
  const y = new Date(now.getTime() - 86_400_000);
  return [1, 2].flatMap((l) => [id(uuid, l as Severity, now), id(uuid, l as Severity, y)]);
};

export type GaugeState = { kind: 'high'; level: Severity } | { kind: 'normal' } | { kind: 'unknown' };

/** What a gauge says now. "unknown" (offline, out of date) never lifts a running alert. */
export function gaugeState(s: PegelStation, now = new Date()): GaugeState {
  const m = s.timeseries?.find((t) => t.shortname === 'W')?.currentMeasurement;
  if (!m) return { kind: 'unknown' };
  if (now.getTime() - Date.parse(m.timestamp) > MAX_AGE_MS) return { kind: 'unknown' };
  if (m.stateMnwMhw === 'high') return { kind: 'high', level: 2 };
  if (m.stateNswHsw === 'high') return { kind: 'high', level: 1 };
  const states = [m.stateMnwMhw, m.stateNswHsw];
  if (states.some((x) => x === 'out-dated' || x === 'commented')) return { kind: 'unknown' };
  return { kind: 'normal' };
}

export function gaugeItem(s: PegelStation, now = new Date()): SourceItem | null {
  const st = gaugeState(s, now);
  if (st.kind !== 'high' || s.latitude == null || s.longitude == null) return null;
  if (countryNear(s.latitude, s.longitude) !== 'DE') return null;
  const m = s.timeseries!.find((t) => t.shortname === 'W')!.currentMeasurement!;
  const station = niceName(s.longname || s.shortname);
  const water = s.water?.longname ? niceName(s.water.longname) : '';
  const at = new Date(m.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  const flood = st.level === 2;
  const self = id(s.uuid, st.level, now);
  return {
    source: 'pegelonline',
    sourceName: 'PEGELONLINE (Wasserstraßen- und Schifffahrtsverwaltung des Bundes)',
    externalId: self,
    // Same gauge, other level or yesterday: one event per flood; a lower level updates it.
    references: familyIds(s.uuid, now).filter((x) => x !== self),
    official: true,
    structured: true,
    hazard: 'flood',
    category: 'weather',
    language: 'de',
    country: 'DE',
    // "Elbe bei Dresden": works for every river name (der Rhein, die Elbe) without guessing its gender.
    // Short enough for a push title (50 characters).
    title: `${flood ? 'Hochwasser' : 'Erhöhter Wasserstand'}: ${water ? `${water} bei ${station}` : `Pegel ${station}`}`,
    body: `Pegel ${station}: ${Math.round(m.value)} cm (${at} Uhr), ${flood ? 'über dem mittleren Hochwasser.' : 'über dem höchsten Schifffahrtswasserstand.'}`,
    url: s.number ? `https://www.pegelonline.wsv.de/gast/stammdaten?pegelnr=${encodeURIComponent(s.number)}` : 'https://www.pegelonline.wsv.de',
    publishedAt: new Date(Date.parse(m.timestamp) || now.getTime()).toISOString(),
    lat: s.latitude, lon: s.longitude, radiusM: GAUGE_RADIUS_M,
    areaName: water ? `${water}, ${station}` : station,
    officialSeverity: st.level,
  };
}

/**
 * All gauges in one request. Returns new items plus the ids still running, so gauges that fell
 * back to normal get an all-clear (pipeline.reconcileFeed). Gauges without a usable reading keep
 * whatever alert they have.
 */
export async function fetchPegelonline(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: (url: string) => Promise<unknown> = async (url) => {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`PEGELONLINE → HTTP ${res.status}`);
    return res.json();
  },
  opts: { url?: string; now?: Date } = {},
): Promise<{ feedKey: string; items: SourceItem[]; listedIds: Set<string> }> {
  const now = opts.now ?? new Date();
  const feedKey = 'pegelonline:DE';
  const json = await get(opts.url ?? PEGELONLINE_URL);
  if (!Array.isArray(json)) throw new Error('PEGELONLINE: expected a list of stations');
  const items: SourceItem[] = [];
  const listedIds = new Set<string>();
  for (const s of json as PegelStation[]) {
    if (!s?.uuid) continue;
    if (gaugeState(s, now).kind === 'unknown') { familyIds(s.uuid, now).forEach((x) => listedIds.add(x)); continue; }
    const item = gaugeItem(s, now);
    if (!item) continue;
    listedIds.add(item.externalId);
    item.references!.forEach((x) => listedIds.add(x));
    if (await isNew(item.externalId)) items.push({ ...item, feedKey });
  }
  return { feedKey, items, listedIds };
}
