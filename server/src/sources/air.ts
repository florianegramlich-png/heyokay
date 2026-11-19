import type { Severity, SourceItem } from '../types.js';
import { REFRESH_MS, type JsonFetcher } from './heat.js';
import { countryNear } from './usgs.js';

/**
 * Air quality at people's places, from the OpenWeatherMap Air Pollution forecast (same key as
 * heat): https://openweathermap.org/api/air-pollution
 * AQI 1 Good · 2 Fair · 3 Moderate · 4 Poor · 5 Very poor (European scale).
 *
 * Same privacy rule as heat: only 0.1° grid cells are asked about, never a person's place.
 * Calm: "Poor" (4) = feed only; "Very poor" (5) = severity 2. A forecast for later goes under
 * "Coming up" (onsetAt). Matters most in India and during wildfire smoke in the US.
 */
export const OWM_AIR_URL = 'https://api.openweathermap.org/data/2.5/air_pollution/forecast';
const CELL_RADIUS_M = 8000;
const HORIZON_H = 24;

export interface AirForecast { list: Array<{ dt: number; main: { aqi: number }; components?: { pm2_5?: number; pm10?: number; o3?: number } }> }

const SEVERITY: Record<number, Severity> = { 4: 1, 5: 2 };

function inGermanyRegion(lat: number, lon: number) {
  return lat > 45 && lat < 56 && lon > 4 && lon < 17;
}

export function airItem(cell: { lat: number; lon: number }, forecast: AirForecast, now: Date): SourceItem | null {
  const until = now.getTime() + HORIZON_H * 3600_000;
  const slots = (forecast.list ?? []).filter((s) => s.dt * 1000 >= now.getTime() - 3600_000 && s.dt * 1000 <= until);
  const bad = slots.filter((s) => s.main.aqi >= 4);
  if (!bad.length) return null;
  const worst = bad.reduce((a, b) => (b.main.aqi > a.main.aqi ? b : a));
  const severity = SEVERITY[worst.main.aqi];
  const pm25 = worst.components?.pm2_5 != null ? Math.round(worst.components.pm2_5) : null;
  const de = inGermanyRegion(cell.lat, cell.lon);
  const day = new Date(worst.dt * 1000).toISOString().slice(0, 10);
  const key = `${cell.lat.toFixed(2)},${cell.lon.toFixed(2)}`;
  const id = (s: Severity) => `owm:air:${key}:${day}:${s}`;
  const label = worst.main.aqi === 5 ? (de ? 'sehr schlecht' : 'very poor') : (de ? 'schlecht' : 'poor');
  return {
    source: 'owm',
    sourceName: 'OpenWeatherMap',
    externalId: id(severity),
    references: severity === 2 ? [id(1)] : [],
    official: false,
    structured: true,
    hazard: 'air',
    category: 'health',
    language: de ? 'de' : 'en',
    country: countryNear(cell.lat, cell.lon) ?? (de ? 'DE' : undefined),
    title: de ? `Luftqualität: ${label}` : `Air quality: ${label}`,
    body: de
      ? `Vorhersage: Luftqualität ${label}${pm25 != null ? `, Feinstaub (PM2,5) bis ${pm25} µg/m³` : ''}.`
      : `Forecast: air quality ${label}${pm25 != null ? `, fine particles (PM2.5) up to ${pm25} µg/m³` : ''}.`,
    url: `https://openweathermap.org/weathermap?lat=${cell.lat}&lon=${cell.lon}&zoom=10`,
    publishedAt: now.toISOString(),
    lat: cell.lat, lon: cell.lon, radiusM: CELL_RADIUS_M,
    officialSeverity: severity,
    onsetAt: new Date(Math.min(...bad.map((s) => s.dt)) * 1000).toISOString(),
    expiresAt: new Date(Math.max(...bad.map((s) => s.dt)) * 1000 + 3600_000).toISOString(),
    areaName: '',
  };
}

export async function fetchAir(
  cells: Array<{ lat: number; lon: number }>,
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: JsonFetcher,
  opts: { now?: Date; lastChecked?: Map<string, number>; maxCells?: number } = {},
): Promise<{ items: SourceItem[]; checked: number }> {
  const now = opts.now ?? new Date();
  const last = opts.lastChecked ?? new Map<string, number>();
  const items: SourceItem[] = [];
  let checked = 0;
  for (const cell of cells.slice(0, opts.maxCells ?? 500)) {
    const key = `${cell.lat},${cell.lon}`;
    if (now.getTime() - (last.get(key) ?? 0) < REFRESH_MS) continue;
    const forecast = (await get(`${OWM_AIR_URL}?lat=${cell.lat}&lon=${cell.lon}`)) as AirForecast;
    last.set(key, now.getTime());
    checked++;
    const item = airItem(cell, forecast, now);
    if (item && (await isNew(item.externalId))) items.push(item);
  }
  return { items, checked };
}
