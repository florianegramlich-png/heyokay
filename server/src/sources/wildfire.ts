import type { Severity, SourceItem } from '../types.js';
import { countryNear } from './usgs.js';
import { fetchWithTimeout } from '../http.js';

/**
 * US wildfires from NIFC's WFIGS "current incident locations" (Wildland Fire Interagency
 * Geospatial Services; public domain, no key; updated every few minutes):
 * https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-incident-locations
 *
 * The record says how big a fire is and how much of it is contained. That's what people near it
 * want to know; evacuation orders come from local officials through FEMA IPAWS, which stay the
 * authority. Calm by design:
 *   10+ acres → feed (1) · 100+ acres → may push (2) · 1,000+ acres → may push (3)
 *   half contained, or burning for more than two weeks → feed only (people nearby know by then)
 *   90% contained → no new alert · out, fully contained or no update for a week → all-clear.
 * Prescribed burns (RX) are never alerts. Smoke is covered by the air-quality alert.
 */
export const WFIGS_URL = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';

const FIELDS = [
  'IrwinID', 'IncidentName', 'IncidentTypeCategory', 'IncidentSize', 'PercentContained', 'FireDiscoveryDateTime',
  'FireOutDateTime', 'ContainmentDateTime', 'ControlDateTime', 'ModifiedOnDateTime_dt', 'POOState', 'POOCounty',
  'IncidentShortDescription',
];

export function wfigsQueryUrl(base = WFIGS_URL): string {
  const q = new URLSearchParams({
    where: "IncidentTypeCategory='WF' AND FireOutDateTime IS NULL AND IncidentSize >= 10",
    outFields: FIELDS.join(','),
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '2000',
    f: 'json',
  });
  return `${base}?${q}`;
}

export interface WfigsFeature {
  attributes: {
    IrwinID: string; IncidentName: string; IncidentTypeCategory?: string; IncidentSize?: number | null;
    PercentContained?: number | null; FireDiscoveryDateTime?: number | null; FireOutDateTime?: number | null;
    ContainmentDateTime?: number | null; ControlDateTime?: number | null; ModifiedOnDateTime_dt?: number | null;
    POOState?: string | null; POOCounty?: string | null; IncidentShortDescription?: string | null;
  };
  geometry?: { x: number; y: number } | null;
}

const DAY = 86_400_000;
export type FireState = { kind: 'alert'; level: Severity } | { kind: 'winding_down' } | { kind: 'over' };

/** How serious a fire is for people nearby right now. */
export function fireState(f: WfigsFeature, now = new Date()): FireState {
  const a = f.attributes;
  if (a.IncidentTypeCategory && a.IncidentTypeCategory !== 'WF') return { kind: 'over' };
  if (a.FireOutDateTime || a.ContainmentDateTime || a.ControlDateTime) return { kind: 'over' };
  if (a.ModifiedOnDateTime_dt && now.getTime() - a.ModifiedOnDateTime_dt > 7 * DAY) return { kind: 'over' };
  const contained = a.PercentContained ?? 0;
  if (contained >= 100) return { kind: 'over' };
  if (contained >= 90) return { kind: 'winding_down' };
  const acres = a.IncidentSize ?? 0;
  if (acres < 10) return { kind: 'over' };
  let level: Severity = acres >= 1000 ? 3 : acres >= 100 ? 2 : 1;
  const longRunning = a.FireDiscoveryDateTime != null && now.getTime() - a.FireDiscoveryDateTime > 14 * DAY;
  if (contained >= 50 || longRunning) level = 1;
  return { kind: 'alert', level };
}

/** Who should hear about it: generous around the ignition point, growing with the fire. */
export const fireRadiusM = (acres: number) => (acres >= 10_000 ? 40_000 : acres >= 1000 ? 20_000 : 10_000);

/** "WEST FORK" → "West Fork"; names already in mixed case stay as they are. */
export function fireName(raw: string): string {
  const name = raw.trim();
  if (name !== name.toUpperCase()) return name;
  // Codes like "43W" or "24-06" stay as they are.
  return name.split(/(\s+)/).map((w) => (/\d/.test(w) ? w : w.toLowerCase().replace(/(^|[(/-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase()))).join('');
}

const id = (irwin: string, level: Severity) => `wfigs:${irwin.replace(/[{}]/g, '').toLowerCase()}:${level}`;
const familyIds = (irwin: string) => ([1, 2, 3] as Severity[]).map((l) => id(irwin, l));

export function fireItem(f: WfigsFeature, now = new Date()): SourceItem | null {
  const st = fireState(f, now);
  const a = f.attributes;
  if (st.kind !== 'alert' || !f.geometry || !a.IrwinID) return null;
  const { x: lon, y: lat } = f.geometry;
  if (countryNear(lat, lon) !== 'US') return null;
  const acres = a.IncidentSize ?? 0;
  const contained = a.PercentContained;
  const state = (a.POOState ?? '').replace(/^US-/, '');
  // The short description is often a template with empty fields ("null Miles null from null, ").
  const desc = (a.IncidentShortDescription ?? '').trim();
  const where = desc && !/\bnull\b/i.test(desc) ? desc : [a.POOCounty ? `${a.POOCounty} County` : '', state].filter(Boolean).join(', ');
  const self = id(a.IrwinID, st.level);
  return {
    source: 'wfigs',
    sourceName: 'NIFC wildfire incidents (WFIGS)',
    externalId: self,
    // Same fire at another level: one event; it grows (escalates) or calms down (update).
    references: familyIds(a.IrwinID).filter((x) => x !== self),
    official: true,
    structured: true,
    hazard: 'wildfire',
    category: 'public_safety',
    language: 'en',
    country: 'US',
    title: `Wildfire: ${fireName(a.IncidentName)}`,
    body: [
      `${Math.round(acres).toLocaleString('en-US')} acres${contained != null ? `, ${Math.round(contained)}% contained` : ''}.`,
      where ? `${where.replace(/\.$/, '')}.` : '',
    ].filter(Boolean).join(' '),
    publishedAt: new Date(a.FireDiscoveryDateTime ?? now.getTime()).toISOString(),
    lat, lon, radiusM: fireRadiusM(acres),
    areaName: where,
    officialSeverity: st.level,
  };
}

/**
 * All active US wildfires (10+ acres) in one request. Returns new items plus the ids still
 * running, so fires that are out, contained or no longer reported get an all-clear.
 */
export async function fetchWildfires(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: (url: string) => Promise<unknown> = async (url) => {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`WFIGS → HTTP ${res.status}`);
    return res.json();
  },
  opts: { url?: string; now?: Date } = {},
): Promise<{ feedKey: string; items: SourceItem[]; listedIds: Set<string> }> {
  const now = opts.now ?? new Date();
  const feedKey = 'wfigs:US';
  const json = (await get(wfigsQueryUrl(opts.url ?? WFIGS_URL))) as { features?: WfigsFeature[]; error?: { message?: string }; exceededTransferLimit?: boolean };
  // ArcGIS reports errors with HTTP 200 and an `error` object.
  if (json.error || !Array.isArray(json.features)) throw new Error(`WFIGS: ${json.error?.message ?? 'no features in the answer'}`);
  // A cut-off list would look like fires going out: fail instead of sending all-clears.
  if (json.exceededTransferLimit) throw new Error('WFIGS: more fires than one page holds');
  const items: SourceItem[] = [];
  const listedIds = new Set<string>();
  for (const f of json.features) {
    if (!f?.attributes?.IrwinID) continue;
    const st = fireState(f, now);
    if (st.kind === 'winding_down') { familyIds(f.attributes.IrwinID).forEach((x) => listedIds.add(x)); continue; }
    const item = fireItem(f, now);
    if (!item) continue;
    listedIds.add(item.externalId);
    item.references!.forEach((x) => listedIds.add(x));
    if (await isNew(item.externalId)) items.push({ ...item, feedKey });
  }
  return { feedKey, items, listedIds };
}
