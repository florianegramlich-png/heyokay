import type { Severity, SourceItem } from '../types.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Heat at people's places (PRD 5.4: "38 °C at your mother's address"), from the OpenWeatherMap
 * 5-day / 3-hour forecast (free plan): https://openweathermap.org/forecast5
 *
 * Privacy: OpenWeatherMap never sees a person's place. We ask about grid cells (0.1°, roughly
 * 11 × 7 km) that contain at least one saved place or current location, each cell once, so a
 * request can't be traced to a person or an address.
 *
 * Calm by design: this is a forecast, not an official warning (DWD's official HITZE warnings
 * arrive via NINA/DWD). Felt temperature over the next 24 hours:
 *   ≥ 32 °C → severity 1 (feed only), ≥ 35 °C → 2, ≥ 38 °C → 3. Never higher.
 */
export const OWM_FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';
export const CELL_DEG = 0.1;
/** The cell's radius for matching: places anywhere in the cell are inside. */
const CELL_RADIUS_M = 8000;
const HORIZON_H = 24;
/** One forecast per cell every 3 hours (the forecast's own step). */
export const REFRESH_MS = 3 * 3600_000;

export interface ForecastSlot { dt: number; main: { temp: number; feels_like: number } }
export interface Forecast { list: ForecastSlot[]; city?: { timezone?: number } }

export function heatSeverity(feelsLikeC: number, thresholdC = 32): Severity | null {
  if (feelsLikeC >= thresholdC + 6) return 3;
  if (feelsLikeC >= thresholdC + 3) return 2;
  if (feelsLikeC >= thresholdC) return 1;
  return null;
}

/** Germany (and neighbours) get German text, elsewhere English with °F too (US test mode). */
function inGermanyRegion(lat: number, lon: number) {
  return lat > 45 && lat < 56 && lon > 4 && lon < 17;
}

const f = (c: number) => Math.round(c * 9 / 5 + 32);

/**
 * One item per cell, day and level. A higher level the same day references the lower one, so the
 * pipeline treats it as an escalation of the same event, not a second heat alert.
 */
export function heatItem(cell: { lat: number; lon: number }, forecast: Forecast, now: Date, thresholdC = 32): SourceItem | null {
  const until = now.getTime() + HORIZON_H * 3600_000;
  const slots = (forecast.list ?? []).filter((s) => s.dt * 1000 >= now.getTime() - 3 * 3600_000 && s.dt * 1000 <= until);
  const hot = slots.filter((s) => heatSeverity(s.main.feels_like, thresholdC) != null);
  if (!hot.length) return null;
  const peak = hot.reduce((a, b) => (b.main.feels_like > a.main.feels_like ? b : a));
  const severity = heatSeverity(peak.main.feels_like, thresholdC)!;
  const maxFeels = Math.round(peak.main.feels_like);
  const maxTemp = Math.round(Math.max(...hot.map((s) => s.main.temp)));
  const tz = forecast.city?.timezone ?? 0;
  const localDay = new Date(peak.dt * 1000 + tz * 1000).toISOString().slice(0, 10);
  const de = inGermanyRegion(cell.lat, cell.lon);
  const cellKey = `${cell.lat.toFixed(2)},${cell.lon.toFixed(2)}`;
  const id = (level: number) => `owm:heat:${cellKey}:${localDay}:${level}`;
  const lastHot = Math.max(...hot.map((s) => s.dt)) * 1000 + 3 * 3600_000;
  const peakTime = new Date(peak.dt * 1000);

  const title = de ? `Hitze: bis ${maxFeels} °C gefühlt` : `Heat: feels like up to ${maxFeels} °C (${f(maxFeels)} °F)`;
  const body = de
    ? `Vorhersage: Lufttemperatur bis ${maxTemp} °C, gefühlt bis ${maxFeels} °C, am heißesten gegen ${peakTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.`
    : `Forecast: air temperature up to ${maxTemp} °C (${f(maxTemp)} °F), feels like up to ${maxFeels} °C (${f(maxFeels)} °F).`;
  return {
    source: 'owm',
    sourceName: 'OpenWeatherMap',
    externalId: id(severity),
    references: [1, 2].filter((l) => l < severity).map(id),
    official: false,
    structured: true,
    hazard: 'heat',
    language: de ? 'de' : 'en',
    country: de ? 'DE' : 'US',
    title,
    body,
    url: `https://openweathermap.org/weathermap?lat=${cell.lat}&lon=${cell.lon}&zoom=10`,
    publishedAt: now.toISOString(),
    lat: cell.lat, lon: cell.lon, radiusM: CELL_RADIUS_M,
    officialSeverity: severity,
    category: 'weather',
    expiresAt: new Date(lastHot).toISOString(),
    areaName: '',
  };
}

export type JsonFetcher = (url: string) => Promise<unknown>;

export function owmFetcher(apiKey: string): JsonFetcher {
  return async (url) => {
    const res = await fetchWithTimeout(`${url}&appid=${encodeURIComponent(apiKey)}`);
    if (!res.ok) throw new Error(`OpenWeatherMap → HTTP ${res.status}`); // the key is never in the message
    return res.json();
  };
}

/**
 * Checks each cell at most every 3 hours (`lastChecked` remembers when). New items only for
 * cell/day/level combinations not seen before.
 */
export async function fetchHeat(
  cells: Array<{ lat: number; lon: number }>,
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: JsonFetcher,
  opts: { now?: Date; thresholdC?: number; lastChecked?: Map<string, number>; maxCells?: number } = {},
): Promise<{ items: SourceItem[]; checked: number; skipped: number }> {
  const now = opts.now ?? new Date();
  const last = opts.lastChecked ?? new Map<string, number>();
  const items: SourceItem[] = [];
  let checked = 0, skipped = 0;
  for (const cell of cells.slice(0, opts.maxCells ?? 500)) {
    const key = `${cell.lat},${cell.lon}`;
    if (now.getTime() - (last.get(key) ?? 0) < REFRESH_MS) { skipped++; continue; }
    const forecast = (await get(`${OWM_FORECAST_URL}?lat=${cell.lat}&lon=${cell.lon}&units=metric`)) as Forecast;
    last.set(key, now.getTime());
    checked++;
    const item = heatItem(cell, forecast, now, opts.thresholdC);
    if (item && (await isNew(item.externalId))) items.push(item);
  }
  return { items, checked, skipped };
}
