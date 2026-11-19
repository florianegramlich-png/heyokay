import type { Severity, SourceItem } from '../types.js';
import type { CountryCode } from '../countries.js';
import { COUNTRY_AREAS } from './statuspage.js';
import { pointInRing } from '../geo.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Earthquakes from the US Geological Survey real-time feed (worldwide, public domain, no key):
 * https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
 *
 * An earthquake has already happened when it's reported, so the alert says what happened and what
 * to expect (aftershocks), calmly. Only quakes in our launch countries are used; how far it is
 * felt is estimated from the magnitude. USGS's own impact rating (PAGER: green/yellow/orange/red)
 * raises the level when present.
 */
export const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson';

export interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null; place: string | null; time: number; updated?: number; url?: string;
    tsunami?: number; alert?: string | null; title?: string; type?: string; status?: string;
  };
  geometry: { type: 'Point'; coordinates: [number, number, number?] };
}

/** Roughly where a quake of this magnitude is felt, and how serious it is for people there. */
export function quakeImpact(mag: number, pager?: string | null): { severity: Severity; radiusM: number } | null {
  if (mag < 4) return null; // rarely felt; not worth an alert
  const radiusKm = mag >= 7 ? 500 : mag >= 6 ? 250 : mag >= 5 ? 100 : 40;
  let severity: Severity = mag >= 7 ? 4 : mag >= 6 ? 3 : mag >= 5 ? 2 : 1;
  if (pager === 'red') severity = 5;
  else if (pager === 'orange') severity = Math.max(severity, 4) as Severity;
  return { severity, radiusM: radiusKm * 1000 };
}

const BOXES: Array<{ code: CountryCode; minLat: number; maxLat: number; minLon: number; maxLon: number }> = [
  { code: 'DE', minLat: 47.2, maxLat: 55.1, minLon: 5.8, maxLon: 15.1 },
  { code: 'IN', minLat: 6.5, maxLat: 35.7, minLon: 68.0, maxLon: 97.5 },
];

/** Launch country containing (or, offshore, near) a point. US: the country outline, widened a little. */
export function countryNear(lat: number, lon: number): CountryCode | null {
  const us = COUNTRY_AREAS.US!.areas;
  for (const [dLat, dLon] of [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.7], [0, -0.7]]) {
    if (us.some((r) => pointInRing(lat + dLat, lon + dLon, r))) return 'US';
  }
  return BOXES.find((b) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon)?.code ?? null;
}

export function quakeItem(f: UsgsFeature, now = new Date()): SourceItem | null {
  const p = f.properties;
  if ((p.type ?? 'earthquake') !== 'earthquake' || p.mag == null) return null;
  const [lon, lat, depth] = f.geometry.coordinates;
  const impact = quakeImpact(p.mag, p.alert);
  if (!impact) return null;
  const country = countryNear(lat, lon);
  if (!country) return null;
  const de = country === 'DE';
  const mag = p.mag.toFixed(1);
  const where = p.place ?? '';
  const when = new Date(p.time);
  const tsunami = p.tsunami === 1;
  return {
    source: 'usgs',
    sourceName: 'USGS Earthquake Hazards Program',
    externalId: `usgs:${f.id}`,
    official: true,
    structured: true,
    hazard: 'earthquake',
    category: 'public_safety',
    language: de ? 'de' : 'en',
    country,
    title: de ? `Erdbeben der Stärke ${mag}` : `Magnitude ${mag} earthquake`,
    body: [
      de ? `Erdbeben der Stärke ${mag}${where ? ` (${where})` : ''}${depth != null ? `, Tiefe ${Math.round(depth)} km` : ''}.`
         : `A magnitude ${mag} earthquake${where ? ` ${where}` : ''}${depth != null ? `, ${Math.round(depth)} km deep` : ''}.`,
      tsunami ? (de ? 'Tsunami-Hinweis: offizielle Tsunami-Warnungen beachten.' : 'Tsunami flag set: follow official tsunami warnings.') : '',
    ].filter(Boolean).join(' '),
    url: p.url,
    publishedAt: when.toISOString(),
    lat, lon, radiusM: impact.radiusM,
    areaName: where,
    officialSeverity: impact.severity,
    // Aftershocks are most likely in the first day.
    expiresAt: new Date(when.getTime() + 24 * 3600_000).toISOString(),
  };
}

export async function fetchQuakes(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: (url: string) => Promise<unknown> = async (url) => {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/geo+json, application/json' } });
    if (!res.ok) throw new Error(`USGS → HTTP ${res.status}`);
    return res.json();
  },
  opts: { url?: string; now?: Date } = {},
): Promise<SourceItem[]> {
  const json = (await get(opts.url ?? USGS_URL)) as { features?: UsgsFeature[] };
  const out: SourceItem[] = [];
  for (const f of json.features ?? []) {
    const item = quakeItem(f, opts.now);
    if (item && (await isNew(item.externalId))) out.push(item);
  }
  return out;
}
