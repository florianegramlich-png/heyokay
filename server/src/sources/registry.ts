import type { CountryCode } from '../countries.js';
import { isCountry } from '../countries.js';
import type { SourceStatus } from '../ingest.js';
import { US_STATUS_PAGES } from './statuspage.js';

/**
 * Source registry (PRD 11 "data source failure"; country packs, docs/ARCHITECTURE.md §8 step 4).
 *
 * Every polled feed is an approved, described source: who publishes it, which country it covers,
 * whether it is official, and which source takes over when it fails. The worker runs only the
 * sources of the countries in `COUNTRIES`; the Alert Desk shows each one's health.
 * New country = a pack in countries.ts + adapters + entries here.
 */
export interface SourceInfo {
  key: string;
  name: string;
  /** '*' = follows people's places (any country), e.g. heat forecasts. */
  country: CountryCode | '*';
  official: boolean;
  category: 'warnings' | 'weather' | 'police' | 'fire' | 'transit' | 'technology' | 'news' | 'system';
  /** Key (prefix) of the source that covers this one's area when it fails. */
  fallback?: string;
  /** Where its terms and format are documented. */
  docs?: string;
}

const NINA_NAMES: Record<string, string> = {
  mowas: 'NINA · MoWaS (Bund/Länder)', katwarn: 'NINA · KATWARN', biwapp: 'NINA · BIWAPP',
  dwd: 'NINA · Deutscher Wetterdienst', lhp: 'NINA · Hochwasserportal', police: 'NINA · Polizei',
};

/** What we know about a task key; unknown keys (e.g. a custom RSS feed) get a sensible default. */
export function describeSource(key: string): SourceInfo {
  const [kind, rest = ''] = key.split(/:(.*)/s);
  switch (kind) {
    case 'nina':
      return { key, name: NINA_NAMES[rest] ?? `NINA · ${rest}`, country: 'DE', official: true, category: rest === 'dwd' ? 'weather' : 'warnings',
        ...(rest === 'dwd' ? { fallback: 'dwd:direct' } : {}), docs: 'https://warnung.bund.de/api31' };
    case 'dwd':
      return { key, name: 'Deutscher Wetterdienst (Open Data)', country: 'DE', official: true, category: 'weather', docs: 'https://opendata.dwd.de/weather/alerts/' };
    case 'presseportal':
      return { key, name: `Presseportal · ${rest}`, country: 'DE', official: false, category: rest.startsWith('feuerwehr') ? 'fire' : 'police', docs: 'https://www.presseportal.de/blaulicht/' };
    case 'feuerwehr-berlin':
      return { key, name: 'Berliner Feuerwehr', country: 'DE', official: false, category: 'fire', docs: 'https://www.berliner-feuerwehr.de/service/rss-feeds/' };
    case 'owm':
      return { key, name: rest === 'air' ? 'OpenWeatherMap · Luftqualität' : 'OpenWeatherMap · Hitze', country: '*', official: false, category: 'weather', docs: 'https://openweathermap.org/forecast5' };
    case 'nws':
      return { key, name: `US National Weather Service · ${rest}`, country: 'US', official: true, category: 'warnings', docs: 'https://www.weather.gov/documentation/services-web-api' };
    case 'statuspage': {
      const page = US_STATUS_PAGES.find((p) => p.key === rest);
      return { key, name: `Status page · ${page?.name ?? rest}`, country: page?.country ?? 'US', official: false, category: 'technology', docs: page?.url ?? 'https://developer.statuspage.io' };
    }
    case 'ipaws':
      return { key, name: 'FEMA IPAWS (US public alerts)', country: 'US', official: true, category: 'warnings', fallback: 'nws', docs: 'https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system' };
    case 'sachet':
      return { key, name: 'NDMA SACHET (India public alerts)', country: 'IN', official: true, category: 'warnings', docs: 'https://sachet.ndma.gov.in' };
    case 'usgs':
      return { key, name: 'USGS earthquakes (worldwide; DE, US, IN used)', country: '*', official: true, category: 'warnings', docs: 'https://earthquake.usgs.gov/earthquakes/feed/' };
    case 'pegelonline':
      return { key, name: 'PEGELONLINE (WSV) · Wasserstände', country: 'DE', official: true, category: 'weather', fallback: 'nina:lhp', docs: 'https://www.pegelonline.wsv.de/webservice/dokuRestapi' };
    case 'wfigs':
      return { key, name: 'NIFC wildfire incidents (WFIGS)', country: 'US', official: true, category: 'fire', fallback: 'ipaws', docs: 'https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-incident-locations' };
    case 'rss':
      return { key, name: rest || 'RSS', country: 'DE', official: false, category: 'news' };
    case 'push':
      return { key, name: rest === 'receipts' ? 'Push receipts' : rest === 'digest' ? 'Evening summaries' : 'Delivery queue', country: '*', official: false, category: 'system' };
    default:
      return { key, name: key, country: '*', official: false, category: 'news' };
  }
}

/** `COUNTRIES=DE,AT`. Unset or empty = every country we have sources for. */
export function parseCountries(raw: string | undefined): CountryCode[] | null {
  const list = (raw ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!list.length) return null;
  const bad = list.filter((c) => !isCountry(c));
  if (bad.length) throw new Error(`COUNTRIES: unknown ${bad.join(', ')} (known: DE, AT, CH, US, IN)`);
  return list as CountryCode[];
}

export function sourceEnabled(info: SourceInfo, countries: CountryCode[] | null): boolean {
  return !countries || info.country === '*' || countries.includes(info.country);
}

export type SourceHealth = 'ok' | 'failing' | 'stale' | 'waiting';

/**
 * ok: last poll worked and is recent · failing: the last poll failed · stale: no successful poll
 * for 3 intervals (the worker may be down) · waiting: never polled yet.
 */
export function sourceHealth(s: SourceStatus | undefined, pollIntervalSec: number, now = Date.now()): SourceHealth {
  if (!s || (!s.lastOkAt && !s.lastErrorAt)) return 'waiting';
  const ok = s.lastOkAt ? Date.parse(s.lastOkAt) : 0;
  const err = s.lastErrorAt ? Date.parse(s.lastErrorAt) : 0;
  if (err > ok) return 'failing';
  if (pollIntervalSec > 0 && now - ok > 3 * pollIntervalSec * 1000) return 'stale';
  return 'ok';
}

export interface SourceReport extends SourceInfo { health: SourceHealth; lastOkAt: string | null; lastErrorAt: string | null; lastDurationMs: number | null }

/** Registry + latest status for the Alert Desk; failing first, then stale. */
export function sourceReport(statuses: Record<string, SourceStatus>, pollIntervalSec: number, now = Date.now()): SourceReport[] {
  const order: Record<SourceHealth, number> = { failing: 0, stale: 1, waiting: 2, ok: 3 };
  return Object.entries(statuses)
    .map(([key, s]) => ({ ...describeSource(key), health: sourceHealth(s, pollIntervalSec, now), lastOkAt: s.lastOkAt, lastErrorAt: s.lastErrorAt, lastDurationMs: s.lastDurationMs }))
    .sort((a, b) => order[a.health] - order[b.health] || a.key.localeCompare(b.key));
}
