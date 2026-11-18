import type { SourceItem } from '../types.js';
import { geojsonCircle, mapCategory, mapSeverity } from './nina.js';
import { outerRings, thinRing } from '../geo.js';
import { fetchWithTimeout } from '../http.js';

/**
 * US National Weather Service active alerts (CAP via api.weather.gov).
 * Official, structured and free; used for US testing and a future US market.
 * Docs: https://www.weather.gov/documentation/services-web-api
 *
 * Most NWS alerts carry no polygon, only "affected zones". Zone shapes are fetched once
 * and cached, then merged into one matching circle like NINA warnings.
 */
export const NWS_BASE = 'https://api.weather.gov';

/** Big alerts (e.g. a tsunami warning for 400+ zones) would be one useless giant circle. */
const MAX_ZONES = 12;

type Geometry = { type: string; coordinates: any } | null;

export interface NwsFeature {
  id?: string;
  geometry: Geometry;
  properties: {
    id: string;
    areaDesc?: string;
    affectedZones?: string[];
    references?: Array<{ identifier: string }>;
    sent?: string;
    effective?: string;
    expires?: string;
    ends?: string | null;
    status?: string; // Actual | Exercise | System | Test | Draft
    messageType?: string; // Alert | Update | Cancel
    category?: string; // Met | Safety | Security | Fire | Health | ...
    severity?: string;
    event?: string;
    senderName?: string;
    headline?: string | null;
    description?: string | null;
    instruction?: string | null;
  };
}

/**
 * "Wind Advisory issued November 17 at 9:58AM PST until November 18 at 5:00PM PST by NWS San Francisco CA"
 * → "Wind Advisory until November 18 at 5:00PM PST"
 */
export function cleanHeadline(headline: string | null | undefined, event: string | undefined): string {
  if (!headline) return event ?? 'Weather alert';
  return headline
    .replace(/\s+issued\s+.*?(?=\s+(until|for|from)\s)/i, '')
    .replace(/\s+issued\s+.*$/i, '')
    .replace(/\s+by\s+NWS\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a SourceItem from one NWS alert. Pure — tested with fixtures. Returns null for tests/exercises or unlocatable alerts. */
export function toSourceItem(f: NwsFeature, zoneShapes: Map<string, Geometry>): SourceItem | null {
  const p = f.properties;
  if ((p.status ?? 'Actual') !== 'Actual') return null;

  const own = f.geometry ? geojsonCircle({ features: [{ geometry: f.geometry }] }) : null;
  const zones = (p.affectedZones ?? []).slice(0, MAX_ZONES).map((z) => zoneShapes.get(z)).filter(Boolean) as NonNullable<Geometry>[];
  const circle = own ?? (zones.length ? geojsonCircle({ features: zones.map((geometry) => ({ geometry })) }) : null);
  if (!circle) return null;
  const areas = (f.geometry ? outerRings(f.geometry) : zones.flatMap(outerRings)).map((r) => thinRing(r));

  const cancelled = (p.messageType ?? '').toLowerCase() === 'cancel';
  return {
    source: 'nws',
    sourceName: p.senderName || 'National Weather Service',
    externalId: p.id,
    references: (p.references ?? []).map((r) => r.identifier),
    official: true,
    language: 'en',
    country: 'US',
    title: cleanHeadline(p.headline, p.event),
    body: [p.description, p.instruction].filter(Boolean).join('\n\n').trim(),
    url: `https://forecast.weather.gov/MapClick.php?lat=${circle.lat.toFixed(4)}&lon=${circle.lon.toFixed(4)}`,
    publishedAt: p.sent ?? p.effective ?? new Date().toISOString(),
    lat: circle.lat, lon: circle.lon, radiusM: Math.round(circle.radiusM),
    areas,
    officialSeverity: mapSeverity(p.severity),
    category: mapCategory('nws', p.category ? [p.category] : []),
    expiresAt: cancelled ? new Date().toISOString() : (p.ends ?? p.expires ?? undefined),
    areaName: p.areaDesc || undefined,
  };
}

export type NwsFetcher = (url: string) => Promise<any>;

/** NWS asks every client to identify itself with a contact in the User-Agent. */
export function nwsFetcher(userAgent: string): NwsFetcher {
  return async (url) => {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/geo+json', 'User-Agent': userAgent } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  };
}

const zoneCache = new Map<string, Geometry>();

/**
 * Poll active alerts for one area: a state code ("CA"), a marine area, or "lat,lon" for a point.
 * Builds items only for alerts not seen before (`isNew`), and returns the ids of everything still
 * listed, so the pipeline can tell when an alert was lifted early (NWS drops cancelled alerts).
 */
export async function fetchNwsArea(area: string, isNew: (externalId: string) => boolean | Promise<boolean>, get: NwsFetcher, cache = zoneCache): Promise<{ feedKey: string; items: SourceItem[]; listedIds: Set<string> }> {
  const feedKey = `nws:${area.toUpperCase()}`;
  const q = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(area) ? `point=${area}` : `area=${encodeURIComponent(area.toUpperCase())}`;
  const data = await get(`${NWS_BASE}/alerts/active?${q}&status=actual`);
  const out: SourceItem[] = [];
  const listedIds = new Set<string>();
  for (const f of (data?.features ?? []) as NwsFeature[]) {
    if (!f?.properties?.id || (f.properties.status ?? 'Actual') !== 'Actual') continue;
    listedIds.add(f.properties.id);
    if (!(await isNew(f.properties.id))) continue;
    if (!f.geometry) {
      for (const z of (f.properties.affectedZones ?? []).slice(0, MAX_ZONES)) {
        if (cache.has(z)) continue;
        try { cache.set(z, (await get(z))?.geometry ?? null); } catch { cache.set(z, null); }
      }
    }
    const item = toSourceItem(f, cache);
    if (item) out.push({ ...item, feedKey });
  }
  return { feedKey, items: out, listedIds };
}
