import type { SourceItem, Severity } from '../types.js';
import { fetchWithTimeout } from '../http.js';
import { CA_UV_PLACES } from '../data/ca-uv-places.js';
import { UV_HIGH, UV_MIN } from './dwd-health.js';

/**
 * UV index forecast for California from the US EPA (Envirofacts UV Index API, public, no key, a US
 * government work): https://www.epa.gov/enviro/uv-index-overview, one daily value per ZIP code:
 * `data.epa.gov/efservice/getEnvirofactsUVDAILY/ZIP/{zip}/JSON`.
 *
 * Same opt-in "Pollen & UV" topic as Germany's DWD forecast (dwd-health.ts), same levels: UV 6–7
 * in the feed, 8 and up may push, once, in the morning (rank.ts). Read once a day after 07:05
 * Los Angeles time, today only. In English. India: later.
 */
export const EPA_UV_URL = 'https://data.epa.gov/efservice/getEnvirofactsUVDAILY/ZIP';
const TZ = 'America/Los_Angeles';

/** Calendar date in a time zone: "2026-11-22". */
export function localDate(t: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov/22/2026" → "2026-11-22". */
export function epaDate(s: string | undefined): string | null {
  const m = (s ?? '').match(/^([A-Za-z]{3})\/(\d{2})\/(\d{4})$/);
  const mo = m ? MONTHS.indexOf(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : -1;
  return m && mo >= 0 ? `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[2]}` : null;
}

interface EpaRow { ZIP_CODE?: string; CITY?: string; UV_INDEX?: string | number; DATE?: string }

/** The alert for one place, when today's forecast reaches UV 6. */
export function uvItem(place: string, rows: EpaRow[], date: string): SourceItem | null {
  const p = CA_UV_PLACES[place];
  const row = rows.find((r) => epaDate(r.DATE) === date);
  const uv = Number(row?.UV_INDEX);
  if (!p || !row || !Number.isFinite(uv) || uv < UV_MIN) return null;
  const high = uv >= UV_HIGH;
  // Midday in California, as the instant the forecast is for; the day ends at local midnight.
  const noon = Date.parse(`${date}T20:00:00Z`);
  return {
    source: 'epa-uv',
    sourceName: 'US EPA · UV Index',
    externalId: `epa-uv:${date}:${p.zip}`,
    official: true,
    structured: true,
    hazard: 'uv',
    category: 'pollen_uv',
    pollenUv: 'uv',
    language: 'en',
    country: 'US',
    title: `UV index today: ${uv}${uv >= 11 ? ' (extreme)' : high ? ' (very high)' : ' (high)'}`,
    body: `UV index up to ${uv} today around ${place}. Source: US EPA.`,
    url: 'https://www.epa.gov/sunsafety/uv-index-1',
    publishedAt: new Date(noon - 6 * 3600_000).toISOString(),
    expiresAt: new Date(noon + 12 * 3600_000).toISOString(),
    lat: p.lat, lon: p.lon, radiusM: 400_000,
    areaName: `${place} area`,
    areas: p.rings,
    officialSeverity: (high ? 2 : 1) as Severity,
  };
}

type Get = (url: string) => Promise<string>;
const defaultGet: Get = async (url) => {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'HeyOkay/0.1 (safety alerts; contact via app)' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
};

/** Today's (California) UV alerts that are new; one small request per place. */
export async function fetchCaliforniaUv(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: Get = defaultGet,
  opts: { now?: Date; url?: string } = {},
): Promise<SourceItem[]> {
  const date = localDate(opts.now ?? new Date(), TZ);
  const out: SourceItem[] = [];
  for (const [place, p] of Object.entries(CA_UV_PLACES)) {
    let rows: unknown;
    try { rows = JSON.parse(await get(`${opts.url ?? EPA_UV_URL}/${p.zip}/JSON`)); } catch { throw new Error(`EPA UV ${p.zip}: answer is not JSON`); }
    if (!Array.isArray(rows)) throw new Error(`EPA UV ${p.zip}: unexpected format`); // e.g. {"error": "..."}
    const item = uvItem(place, rows as EpaRow[], date);
    if (item && (await isNew(item.externalId))) out.push(item);
  }
  return out;
}

/** Once a day, after 07:05 in California. */
export function californiaUvDue(now: Date, lastRunDate: string | null): boolean {
  if (lastRunDate === localDate(now, TZ)) return false;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return hm >= '07:05';
}
