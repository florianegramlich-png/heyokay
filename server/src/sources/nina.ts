import type { Category, Severity, SourceItem } from '../types.js';
import { enclosingCircle, outerRings, polygonCircle, thinRing } from '../geo.js';

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

/** More outlines than this (a warning for hundreds of municipalities) and the circle is used instead, to keep events small. */
const MAX_AREA_RINGS = 60;

/**
 * Exact warning outlines ([lon, lat] rings) so matching follows the warned area, not the enclosing
 * circle: a drinking-water warning for two villages shouldn't reach the whole district.
 */
export function warningAreas(g: GeoJson | null): [number, number][][] | undefined {
  const rings = (g?.features ?? []).flatMap((f) => outerRings(f.geometry ?? null)).filter((r) => r?.length >= 3);
  if (!rings.length || rings.length > MAX_AREA_RINGS) return undefined;
  return rings.map((r) => thinRing(r, 150));
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
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
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
