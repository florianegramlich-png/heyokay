import type { SourceItem } from '../types.js';
import { enclosingCircle, polygonCircle, thinRing } from '../geo.js';
import { mapSeverity } from './nina.js';
import { readZip } from './zip.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Deutscher Wetterdienst warnings straight from DWD open data, as a fallback for NINA's DWD
 * channel: a full snapshot of all current warnings per district, as CAP 1.2 XML in a ZIP,
 * refreshed every few minutes. https://opendata.dwd.de/weather/alerts/cap/
 *
 * The NINA copy of a DWD warning has a different identifier and a different area split, so the
 * two can't be matched reliably. That's why this feed is polled only while NINA's DWD channel
 * is failing (DWD_DIRECT=fallback, the default), or always for testing (DWD_DIRECT=always).
 */
export const DWD_LATEST_URL =
  'https://opendata.dwd.de/weather/alerts/cap/DISTRICT_DWD_STAT/Z_CAP_C_EDZW_LATEST_PVW_STATUS_PREMIUMDWD_DISTRICT_DE.zip';

export const DWD_FEED_KEY = 'dwd:direct';

export type DwdMode = 'fallback' | 'always' | 'off';

export function parseDwdMode(v: string | undefined): DwdMode {
  const s = (v ?? 'fallback').trim().toLowerCase();
  if (s === 'fallback' || s === 'always' || s === 'off') return s;
  throw new Error(`DWD_DIRECT must be fallback, always or off (got "${v}")`);
}

/** Build a SourceItem from one DWD CAP message. Pure — tested with fixtures. Null for tests/exercises or unlocatable messages. */
export function capToSourceItem(xml: string): SourceItem | null {
  if (text(xml, 'status') !== 'Actual') return null;
  const identifier = text(xml, 'identifier');
  const info = block(xml, 'info');
  if (!identifier || !info) return null;
  const msgType = text(xml, 'msgType');

  // Areas: one or more <polygon> per <area>, as "lat,lon lat,lon …" (CAP order) → [lon, lat] rings.
  const rings: [number, number][][] = [];
  const areaNames: string[] = [];
  for (const a of blocks(info, 'area')) {
    const name = text(a, 'areaDesc');
    if (name) areaNames.push(name);
    for (const poly of all(a, 'polygon')) {
      const ring = poly.trim().split(/\s+/).map((pair) => pair.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)).map(([lat, lon]) => [lon, lat] as [number, number]);
      if (ring.length >= 3) rings.push(ring);
    }
  }
  if (!rings.length) return null;
  const circle = enclosingCircle(rings.map((r) => polygonCircle(r)));

  const headline = text(info, 'headline') || `Amtliche WARNUNG vor ${text(info, 'event')}`;
  const body = [text(info, 'description'), text(info, 'instruction')].filter(Boolean).join('\n\n');
  const expires = text(info, 'expires');
  // "sender,identifier,sent sender,identifier,sent …"
  const references = (text(xml, 'references') || '').split(/\s+/).map((r) => r.split(',')[1]).filter(Boolean);

  return {
    source: 'dwd',
    sourceName: 'Deutscher Wetterdienst',
    externalId: identifier,
    references,
    official: true,
    language: 'de',
    country: 'DE',
    title: headline,
    body: body.trim(),
    url: text(info, 'web') || 'https://www.dwd.de/warnungen',
    publishedAt: toIso(text(xml, 'sent')) ?? new Date().toISOString(),
    lat: circle.lat, lon: circle.lon, radiusM: Math.round(circle.radiusM),
    areas: rings.map((r) => thinRing(r)),
    officialSeverity: mapSeverity(text(info, 'severity')),
    category: 'weather',
    expiresAt: msgType === 'Cancel' ? new Date().toISOString() : (toIso(expires) ?? undefined),
    areaName: areaNames.length > 3 ? `${areaNames.slice(0, 3).join(', ')} und ${areaNames.length - 3} weitere` : areaNames.join(', ') || undefined,
    feedKey: DWD_FEED_KEY,
  };
}

/**
 * Download the current snapshot. Items only for messages not seen before (`isNew`); `listedIds`
 * holds every message still in the snapshot, so warnings dropped early get an all-clear.
 */
export async function fetchDwdSnapshot(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: (url: string) => Promise<Buffer> = binaryFetch,
): Promise<{ feedKey: string; items: SourceItem[]; listedIds: Set<string> }> {
  const files = readZip(await get(DWD_LATEST_URL)).filter((f) => f.name.endsWith('.xml'));
  if (!files.length) throw new Error('DWD snapshot is empty'); // never treat a broken download as "all warnings lifted"
  const items: SourceItem[] = [];
  const listedIds = new Set<string>();
  for (const f of files) {
    const xml = f.data.toString('utf8');
    const id = text(xml, 'identifier');
    if (!id || text(xml, 'status') !== 'Actual') continue;
    listedIds.add(id);
    if (!(await isNew(id))) continue;
    const item = capToSourceItem(xml);
    if (item) items.push(item);
  }
  return { feedKey: DWD_FEED_KEY, items, listedIds };
}

export async function binaryFetch(url: string): Promise<Buffer> {
  const res = await fetchWithTimeout(url, {}, 30_000);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function toIso(s: string): string | null {
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
}

function block(xml: string, tag: string): string {
  return blocks(xml, tag)[0] ?? '';
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map((m) => m[1]);
}

function all(xml: string, tag: string): string[] {
  return blocks(xml, tag);
}

/** First direct value of a simple element, with XML entities decoded. */
function text(xml: string, tag: string): string {
  const v = block(xml, tag);
  return v
    .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}
