import type { Category, Severity, SourceItem } from '../types.js';
import { enclosingCircle, outerRings, polygonCircle, thinRing } from '../geo.js';
import { fetchWithTimeout } from '../http.js';

/**
 * NINA (Bundesamt für Bevölkerungsschutz und Katastrophenhilfe) public API.
 * Carries MoWaS, KATWARN, BIWAPP, DWD weather, LHP flood and police warnings.
 * Docs: https://nina.api.bund.dev/
 */
export const NINA_BASE = 'https://warnung.bund.de/api31';

const CHANNEL_NAMES: Record<string, string> = {
  mowas: 'NINA · MoWaS', katwarn: 'NINA · KATWARN', biwapp: 'NINA · BIWAPP',
  dwd: 'Deutscher Wetterdienst', lhp: 'Länderübergreifendes Hochwasserportal', police: 'Polizei (NINA)',
};

export interface NinaMapEntry {
  id: string;
  version: number;
  startDate?: string;
  expiresDate?: string;
  severity?: string;
  type?: string; // Alert | Update | Cancel
  i18nTitle?: { de?: string; en?: string };
}

export interface NinaWarning {
  identifier: string;
  sent?: string;
  msgType?: string;
  info: Array<{
    language?: string;
    category?: string[];
    event?: string;
    severity?: string;
    headline?: string;
    description?: string;
    instruction?: string;
    /** MoWaS adds the authority's own extra instructions here (`instructionText`). */
    parameter?: Array<{ valueName?: string; value?: string }>;
    web?: string;
    expires?: string;
    area?: Array<{ areaDesc?: string }>;
  }>;
}

interface GeoJson {
  features?: Array<{ geometry?: { type: string; coordinates: any } }>;
}

export function mapSeverity(s?: string): Severity {
  switch ((s ?? '').toLowerCase()) {
    case 'extreme': return 5;
    case 'severe': return 4;
    case 'moderate': return 3;
    case 'minor': return 2;
    default: return 2;
  }
}

export function mapCategory(channel: string, capCategories: string[] = []): Category {
  if (channel === 'dwd' || channel === 'lhp') return 'weather';
  const c = capCategories.map((x) => x.toLowerCase());
  if (c.includes('met') || c.includes('env')) return 'weather';
  if (c.includes('health')) return 'health';
  if (c.includes('transport')) return 'transit';
  if (c.includes('infra')) return 'infrastructure';
  if (channel === 'police' || c.includes('security')) return 'crime';
  return 'public_safety';
}

/** Turn GeoJSON polygons into one matching circle. */
export function geojsonCircle(g: GeoJson): { lat: number; lon: number; radiusM: number } | null {
  const circles: { lat: number; lon: number; radiusM: number }[] = [];
  for (const f of g.features ?? []) {
    const geom = f.geometry;
    if (!geom) continue;
    const rings: [number, number][][] =
      geom.type === 'Polygon' ? [geom.coordinates[0]] :
      geom.type === 'MultiPolygon' ? geom.coordinates.map((p: any) => p[0]) : [];
    for (const ring of rings) if (ring?.length) circles.push(polygonCircle(ring));
  }
  return circles.length ? enclosingCircle(circles) : null;
}

/** Total outline points kept per warning, so events stay small even for warnings over hundreds of municipalities. */
const AREA_POINT_BUDGET = 6000;
/** Fewer points than this per outline and it stops resembling the municipality. */
const MIN_POINTS_PER_RING = 12;

/**
 * Exact warning outlines ([lon, lat] rings) so matching follows the warned area, not the enclosing
 * circle: a drinking-water warning for two villages shouldn't reach the whole district, and a DWD
 * warning for municipalities scattered across several states must not become one circle over half
 * of Germany. Outlines are thinned to fit a point budget; only beyond MAX rings is the circle used.
 */
export function warningAreas(g: GeoJson | null): [number, number][][] | undefined {
  const rings = (g?.features ?? []).flatMap((f) => outerRings(f.geometry ?? null)).filter((r) => r?.length >= 3);
  if (!rings.length || rings.length > AREA_POINT_BUDGET / MIN_POINTS_PER_RING) return undefined;
  const perRing = Math.max(MIN_POINTS_PER_RING, Math.min(150, Math.floor(AREA_POINT_BUDGET / rings.length)));
  return rings.map((r) => thinRing(r, perRing));
}

/** Build a SourceItem from a NINA warning + its GeoJSON. Pure — tested with fixtures. */
export function toSourceItem(channel: string, entry: NinaMapEntry, warning: NinaWarning, geo: GeoJson | null): SourceItem | null {
  const info = warning.info.find((i) => (i.language ?? '').toUpperCase().startsWith('DE')) ?? warning.info[0];
  if (!info) return null;
  const circle = geo ? geojsonCircle(geo) : null;
  const cancelled = (entry.type ?? warning.msgType ?? '').toLowerCase() === 'cancel';
  // The authority's own extra instructions (MoWaS `instructionText`) come after the standard ones.
  const extra = (info.parameter ?? []).find((p) => p.valueName === 'instructionText')?.value;
  const body = [info.description, info.instruction, extra && !(info.instruction ?? '').includes(extra) ? extra : null].filter(Boolean).join('\n\n');
  const areas = warningAreas(geo);
  return {
    source: 'nina',
    sourceName: CHANNEL_NAMES[channel] ?? `NINA · ${channel}`,
    // Version in the id so updates arrive as new items; the clusterer merges them by id root.
    externalId: `${entry.id}@v${entry.version}`,
    official: true,
    title: info.headline ?? entry.i18nTitle?.de ?? info.event ?? 'Warnung',
    body: stripHtml(body),
    url: info.web || `https://warnung.bund.de/meldungen/${encodeURIComponent(entry.id)}`,
    publishedAt: warning.sent ?? entry.startDate ?? new Date().toISOString(),
    lat: circle?.lat, lon: circle?.lon, radiusM: circle?.radiusM,
    ...(areas ? { areas } : {}),
    officialSeverity: mapSeverity(info.severity ?? entry.severity),
    category: mapCategory(channel, info.category),
    expiresAt: cancelled ? new Date().toISOString() : (info.expires ?? entry.expiresDate),
    areaName: (info.area ?? []).map((a) => a.areaDesc).filter(Boolean).join(', ') || undefined,
  };
}

export function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

export type Fetcher = (url: string) => Promise<any>;

export const jsonFetch: Fetcher = async (url) => {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
};

/** Poll one NINA channel. Only fetches details for entries not seen before (`isNew`). */
export async function fetchNinaChannel(channel: string, isNew: (externalId: string) => boolean | Promise<boolean>, get: Fetcher = jsonFetch): Promise<SourceItem[]> {
  const entries = (await get(`${NINA_BASE}/${channel}/mapData.json`)) as NinaMapEntry[];
  const out: SourceItem[] = [];
  for (const entry of entries ?? []) {
    if (!(await isNew(`${entry.id}@v${entry.version}`))) continue;
    try {
      const warning = (await get(`${NINA_BASE}/warnings/${encodeURIComponent(entry.id)}.json`)) as NinaWarning;
      let geo: GeoJson | null = null;
      try { geo = await get(`${NINA_BASE}/warnings/${encodeURIComponent(entry.id)}.geojson`); } catch { /* some warnings have no geometry */ }
      const item = toSourceItem(channel, entry, warning, geo);
      if (item) out.push(item);
    } catch (err) {
      console.warn(`[nina] ${channel} ${entry.id}:`, (err as Error).message);
    }
  }
  return out;
}

/** "mow.DE-BY-...@v3" → "mow.DE-BY-..." */
export function ninaRootId(externalId: string): string {
  return externalId.replace(/@v\d+$/, '');
}
