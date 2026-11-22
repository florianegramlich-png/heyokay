import type { SourceItem, Severity } from '../types.js';
import { fetchWithTimeout } from '../http.js';
import { POLLEN_REGIONS, UV_CITIES } from '../data/dwd-health-areas.js';

/**
 * Pollen and UV forecasts from the Deutscher Wetterdienst (open data, free to use with the source
 * named): https://opendata.dwd.de/climate_environment/health/alerts/
 *
 * - `s31fg.json`: pollen index per pollen area (27 areas) and pollen type, today / tomorrow /
 *   the day after, on DWD's scale 0 … 3 in half steps ("0-1", "2-3"). Updated daily at 11:00.
 * - `uvi.json`: UV index per place (38 places) for the same three days. Updated daily ~07:30.
 *
 * Topic `pollen_uv` ("Pollen & UV"), off by default. One alert per area and pollen type (or UV),
 * for today only: "mittel" (2) and up for pollen, UV 6 and up. Only "hoch" (pollen 2-3 or 3, UV 8+)
 * may become a push, and only in the morning, at most one a day (rank.ts). The worker reads the
 * files once a day after 07:05 Berlin time, so the push lands in the morning, never at night.
 */
export const DWD_HEALTH_URL = 'https://opendata.dwd.de/climate_environment/health/alerts';

/** Pollen types as the forecast names them → our key and German/English names. */
export const POLLEN_TYPES = {
  Hasel: { key: 'hasel', de: 'Hasel', pollen: 'Haselpollen', en: 'Hazel' },
  Erle: { key: 'erle', de: 'Erle', pollen: 'Erlenpollen', en: 'Alder' },
  Esche: { key: 'esche', de: 'Esche', pollen: 'Eschenpollen', en: 'Ash' },
  Birke: { key: 'birke', de: 'Birke', pollen: 'Birkenpollen', en: 'Birch' },
  Graeser: { key: 'graeser', de: 'Gräser', pollen: 'Gräserpollen', en: 'Grasses' },
  Roggen: { key: 'roggen', de: 'Roggen', pollen: 'Roggenpollen', en: 'Rye' },
  Beifuss: { key: 'beifuss', de: 'Beifuß', pollen: 'Beifußpollen', en: 'Mugwort' },
  Ambrosia: { key: 'ambrosia', de: 'Ambrosia', pollen: 'Ambrosiapollen', en: 'Ragweed' },
} as const;
/** What people can pick in "Pollen & UV" (UserPrefs.pollenUv): the pollen types and UV. */
export const POLLEN_UV_KEYS = [...Object.values(POLLEN_TYPES).map((p) => p.key), 'uv'] as const;
export type PollenUvKey = (typeof POLLEN_UV_KEYS)[number];

/** DWD's pollen scale, in order. */
const POLLEN_SCALE = ['0', '0-1', '1', '1-2', '2', '2-3', '3'] as const;
const POLLEN_WORD: Record<string, { de: string; en: string }> = {
  '2': { de: 'mittel', en: 'moderate' },
  '2-3': { de: 'mittel bis hoch', en: 'moderate to high' },
  '3': { de: 'hoch', en: 'high' },
};
/** "mittel" and up become an alert; "2-3" and "3" count as high. */
const POLLEN_MIN = POLLEN_SCALE.indexOf('2');
const POLLEN_HIGH = POLLEN_SCALE.indexOf('2-3');
export const UV_MIN = 6;
export const UV_HIGH = 8;

type Day = 'today' | 'tomorrow' | 'dayafter_to';
const DAYS: Day[] = ['today', 'tomorrow', 'dayafter_to'];

/** Berlin calendar date of an instant: "2026-11-22". */
export function berlinDate(t: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Which key of a file holds `date`. A file issued yesterday calls today "tomorrow"
 * (the pollen file is from 11:00 the day before when the worker reads it in the morning).
 */
export function dayKey(issuedOn: string, date: string): Day | null {
  return DAYS[daysBetween(issuedOn, date)] ?? null;
}

/** End of a Berlin day, as an instant (midnight CET/CEST, taking 22:00 UTC is good enough). */
const endOfDay = (date: string) => `${date}T22:00:00.000Z`;
/** Morning of a Berlin day, for publishedAt. */
const morning = (date: string) => `${date}T06:00:00.000Z`;

interface PollenFile {
  last_update?: string;
  content?: { region_id: number; partregion_id: number; region_name?: string; partregion_name?: string; Pollen?: Record<string, Partial<Record<Day, string>>> }[];
}

/** "2026-11-21 11:00 Uhr" → "2026-11-21". */
const issuedDate = (s: string | undefined) => s?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;

export function pollenItems(file: PollenFile, date: string): SourceItem[] {
  const issued = issuedDate(file.last_update);
  const day = issued ? dayKey(issued, date) : null;
  if (!day || !Array.isArray(file.content)) return [];
  const out: SourceItem[] = [];
  for (const area of file.content) {
    const id = area.partregion_id > 0 ? area.partregion_id : area.region_id;
    const region = POLLEN_REGIONS[id];
    if (!region) continue;
    for (const [name, type] of Object.entries(POLLEN_TYPES)) {
      const value = area.Pollen?.[name]?.[day];
      const level = POLLEN_SCALE.indexOf((value ?? '') as (typeof POLLEN_SCALE)[number]);
      if (level < POLLEN_MIN) continue;
      const high = level >= POLLEN_HIGH;
      const word = POLLEN_WORD[value!];
      out.push({
        source: 'dwd-health',
        sourceName: 'Deutscher Wetterdienst · Pollenflug',
        externalId: `dwd-health:pollen:${date}:${id}:${type.key}`,
        official: true,
        structured: true,
        hazard: 'pollen',
        category: 'pollen_uv',
        pollenUv: type.key,
        language: 'de',
        country: 'DE',
        title: `Pollenflug heute: ${type.de} ${word.de}`,
        body: `${type.pollen} heute ${word.de} (Stufe ${value} von 3) in ${region.name}. Quelle: Deutscher Wetterdienst.`,
        url: 'https://www.dwd.de/DE/leistungen/gefahrenindizespollen/gefahrenindexpollen.html',
        publishedAt: morning(date),
        expiresAt: endOfDay(date),
        ...centre(region.rings),
        areaName: region.name,
        areas: region.rings,
        officialSeverity: (high ? 2 : 1) as Severity,
      });
    }
  }
  return out;
}

interface UvFile {
  forecast_day?: string;
  content?: { city: string; forecast?: Partial<Record<Day, number>> }[];
}

export function uvItems(file: UvFile, date: string): SourceItem[] {
  const issued = file.forecast_day ?? null;
  const day = issued ? dayKey(issued, date) : null;
  if (!day || !Array.isArray(file.content)) return [];
  const out: SourceItem[] = [];
  for (const c of file.content) {
    const city = UV_CITIES[c.city];
    const uv = c.forecast?.[day];
    if (!city || typeof uv !== 'number' || uv < UV_MIN) continue; // mountain stations have no area
    const high = uv >= UV_HIGH;
    out.push({
      source: 'dwd-health',
      sourceName: 'Deutscher Wetterdienst · UV-Index',
      externalId: `dwd-health:uv:${date}:${c.city}`,
      official: true,
      structured: true,
      hazard: 'uv',
      category: 'pollen_uv',
      pollenUv: 'uv',
      language: 'de',
      country: 'DE',
      title: `UV-Index heute: ${uv}${high ? ' (sehr hoch)' : ' (hoch)'}`,
      body: `UV-Index heute bis ${uv} im Raum ${c.city}. Quelle: Deutscher Wetterdienst.`,
      url: 'https://www.dwd.de/DE/leistungen/gefahrenindizesuvi/gefahrenindexuvi.html',
      publishedAt: morning(date),
      expiresAt: endOfDay(date),
      lat: city.lat, lon: city.lon, radiusM: 200_000,
      areaName: `Raum ${c.city}`,
      areas: city.rings,
      officialSeverity: (high ? 2 : 1) as Severity,
    });
  }
  return out;
}

/** Middle of the outlines' bounding box, and a radius that reaches every corner (the outlines decide). */
function centre(rings: [number, number][][]): { lat: number; lon: number; radiusM: number } {
  const pts = rings.flat();
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const dLat = (Math.max(...lats) - Math.min(...lats)) * 111_000, dLon = (Math.max(...lons) - Math.min(...lons)) * 111_000 * Math.cos((lat * Math.PI) / 180);
  return { lat, lon, radiusM: Math.ceil(Math.hypot(dLat, dLon) / 2) + 5_000 };
}

type Get = (url: string) => Promise<string>;
const defaultGet: Get = async (url) => {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'HeyOkay/0.1 (safety alerts; contact via app)' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
};

function parse<T>(text: string, what: string, check: (j: any) => boolean): T {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`DWD ${what}: answer is not JSON`); }
  if (!check(json)) throw new Error(`DWD ${what}: unexpected format`); // a changed file must fail, not look like "no pollen"
  return json as T;
}

/** Today's (Berlin) pollen and UV alerts that are new. */
export async function fetchPollenUv(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: Get = defaultGet,
  opts: { now?: Date; url?: string } = {},
): Promise<SourceItem[]> {
  const date = berlinDate(opts.now ?? new Date());
  const base = opts.url ?? DWD_HEALTH_URL;
  const pollen = parse<PollenFile>(await get(`${base}/s31fg.json`), 'pollen', (j) => Array.isArray(j?.content) && typeof j?.last_update === 'string');
  const uv = parse<UvFile>(await get(`${base}/uvi.json`), 'UV', (j) => Array.isArray(j?.content) && typeof j?.forecast_day === 'string');
  const out: SourceItem[] = [];
  for (const item of [...pollenItems(pollen, date), ...uvItems(uv, date)]) if (await isNew(item.externalId)) out.push(item);
  return out;
}

/** The worker reads the files once a day, after 07:05 Berlin time (after the default quiet hours). */
export function pollenUvDue(now: Date, lastRunDate: string | null): boolean {
  const date = berlinDate(now);
  if (lastRunDate === date) return false;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return hm >= '07:05';
}
