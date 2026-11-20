import type { Severity, SourceItem } from '../types.js';
import type { CountryCode } from '../countries.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Technology outages (PRD v6.5 §1, §5.4): incidents that service providers publish on their own
 * status pages. Most use Atlassian Statuspage, which has the same public JSON API everywhere:
 *   GET <page>/api/v2/incidents/unresolved.json → { incidents: [{ id, name, status, impact, … }] }
 * https://developer.statuspage.io (public "Status API", no key needed)
 *
 * Calm by design: only incidents the provider rates "major" (feed only) or "critical" (may push,
 * severity 3) become alerts — an outage is an inconvenience, not a danger. An incident that leaves
 * the unresolved list gets an all-clear, like an NWS alert that is lifted early.
 *
 * An outage has no street address: it affects everyone in the country who uses the service, so
 * the event covers the whole country (coarse outline below).
 */
export interface StatusPage {
  key: string;
  /** Shown to users: "Square", "Zoom". */
  name: string;
  /** Base URL of the status page, e.g. https://status.zoom.us */
  url: string;
  country: CountryCode;
  /** What people use it for — for the alert text. */
  kind: 'payments' | 'banking' | 'communication' | 'internet' | 'apps' | 'home';
  /**
   * Which public API the page speaks. Missing = Atlassian Statuspage. 'incidentio' = incident.io's
   * status-summary API (GET <page>/api/v1/summary), used by Square since 2026 and by OpenAI.
   */
  api?: 'statuspage' | 'incidentio';
  /** incident.io pages with one sub-page per country (Square): the sub-page to read, e.g. "united-states". */
  subpage?: string;
}

/**
 * US services people rely on day to day that publish a Statuspage. URLs are checked on the first
 * live poll: a wrong one shows as "failing" in the Alert Desk Sources table. Override with
 * STATUS_PAGES (JSON array of StatusPage).
 */
export const US_STATUS_PAGES: StatusPage[] = [
  { key: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflarestatus.com', country: 'US', kind: 'internet' },
  // Square moved its status page to incident.io (the old Statuspage API answers 404 since 2026-10).
  { key: 'square', name: 'Square', url: 'https://www.issquareup.com', country: 'US', kind: 'payments', api: 'incidentio', subpage: 'united-states' },
  { key: 'zoom', name: 'Zoom', url: 'https://status.zoom.us', country: 'US', kind: 'communication' },
  { key: 'discord', name: 'Discord', url: 'https://discordstatus.com', country: 'US', kind: 'communication' },
  { key: 'reddit', name: 'Reddit', url: 'https://www.redditstatus.com', country: 'US', kind: 'apps' },
  { key: 'dropbox', name: 'Dropbox', url: 'https://status.dropbox.com', country: 'US', kind: 'apps' },
  // Money people use every day (added 2026-11-20; each URL answered the public API live that day).
  { key: 'chime', name: 'Chime', url: 'https://status.chime.com', country: 'US', kind: 'banking' },
  { key: 'cashapp', name: 'Cash App', url: 'https://status.cash.app', country: 'US', kind: 'payments' },
  { key: 'affirm', name: 'Affirm', url: 'https://status.affirm.com', country: 'US', kind: 'payments' },
  { key: 'klarna', name: 'Klarna', url: 'https://status.klarna.com', country: 'US', kind: 'payments' },
  { key: 'wise', name: 'Wise', url: 'https://status.wise.com', country: 'US', kind: 'banking' },
  { key: 'robinhood', name: 'Robinhood', url: 'https://status.robinhood.com', country: 'US', kind: 'banking' },
  { key: 'coinbase', name: 'Coinbase', url: 'https://status.coinbase.com', country: 'US', kind: 'banking' },
  { key: 'chatgpt', name: 'ChatGPT', url: 'https://status.openai.com', country: 'US', kind: 'apps', api: 'incidentio' },
  // Home security: an outage can mean cameras and alarms don't reach the phone.
  { key: 'ring', name: 'Ring', url: 'https://status.ring.com', country: 'US', kind: 'home' },
];

/** What the apps show in "only the services I use" (GET /v1/services). */
export interface FollowableService { key: string; name: string; kind: StatusPage['kind']; country: CountryCode }
export function followableServices(pages: StatusPage[]): FollowableService[] {
  return pages.map(({ key, name, kind, country }) => ({ key, name, kind, country }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parseStatusPages(raw: string | undefined): StatusPage[] {
  if (!raw) return US_STATUS_PAGES;
  if (/^(off|none|false|0)$/i.test(raw.trim())) return [];
  return JSON.parse(raw) as StatusPage[];
}

/** Whole-country outlines for nationwide events ([lon, lat] rings). Coarse on purpose. */
export const COUNTRY_AREAS: Partial<Record<CountryCode, { name: string; lat: number; lon: number; radiusM: number; areas: [number, number][][] }>> = {
  US: {
    name: 'United States', lat: 39.8, lon: -98.6, radiusM: 7_000_000, // reaches Hawaii and Alaska; the outlines decide
    areas: [
      // Contiguous states
      [[-124.8, 48.4], [-123.2, 49.0], [-95.2, 49.0], [-89.6, 48.0], [-82.4, 45.3], [-82.5, 41.7], [-79.0, 43.3], [-76.4, 44.2], [-74.7, 45.0], [-71.5, 45.0], [-69.2, 47.5], [-67.0, 45.0], [-66.9, 44.8], [-70.0, 41.5], [-75.0, 38.5], [-75.5, 35.2], [-80.0, 32.0], [-80.0, 25.0], [-81.8, 24.5], [-83.0, 29.0], [-89.5, 29.0], [-94.0, 29.5], [-97.2, 25.9], [-99.5, 27.5], [-101.4, 29.8], [-104.5, 29.6], [-106.5, 31.8], [-111.1, 31.3], [-114.8, 32.5], [-117.1, 32.5], [-120.6, 34.5], [-124.4, 40.4], [-124.8, 48.4]],
      // Alaska
      [[-168.0, 65.6], [-141.0, 69.7], [-141.0, 60.3], [-130.0, 54.7], [-152.0, 57.5], [-166.0, 53.5], [-168.0, 65.6]],
      // Hawaii
      [[-160.9, 22.4], [-154.6, 22.4], [-154.6, 18.8], [-160.9, 18.8], [-160.9, 22.4]],
    ],
  },
};

export interface StatuspageIncident {
  id: string;
  name: string;
  status: string; // investigating | identified | monitoring | resolved | postmortem
  impact: string; // none | minor | major | critical
  created_at: string;
  updated_at?: string;
  shortlink?: string;
  incident_updates?: Array<{ body?: string; status?: string; created_at?: string }>;
  components?: Array<{ name?: string }>;
}

/** major = feed only (severity 1); critical = may push (3). Lower impacts are ignored. */
const IMPACT_SEVERITY: Record<string, Severity> = { major: 1, critical: 3 };

const KIND_TEXT = {
  payments: { en: 'card payments', de: 'Kartenzahlungen' },
  communication: { en: 'calls and messages', de: 'Anrufe und Nachrichten' },
  internet: { en: 'many websites and apps', de: 'viele Websites und Apps' },
  apps: { en: 'the service', de: 'den Dienst' },
  banking: { en: 'banking, transfers and card payments', de: 'Banking, Überweisungen und Kartenzahlungen' },
  home: { en: 'cameras and alarms reaching your phone', de: 'Kameras und Alarme auf dem Handy' },
} as const;

/** Statuspage incident → one item per incident and impact level (a higher level updates the event). */
export function incidentItem(page: StatusPage, inc: StatuspageIncident, now = new Date()): SourceItem | null {
  const severity = IMPACT_SEVERITY[inc.impact];
  if (!severity || inc.status === 'resolved' || inc.status === 'postmortem') return null;
  const area = COUNTRY_AREAS[page.country];
  if (!area) return null;
  const latest = [...(inc.incident_updates ?? [])].sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))[0];
  const update = (latest?.body ?? '').replace(/\s+/g, ' ').trim();
  const components = (inc.components ?? []).map((c) => c.name).filter(Boolean).slice(0, 4).join(', ');
  const id = (level: Severity) => `statuspage:${page.key}:${inc.id}:${level}`;
  const what = KIND_TEXT[page.kind].en;
  return {
    source: 'statuspage',
    sourceName: `${page.name} status page`,
    externalId: id(severity),
    references: severity === 3 ? [id(1)] : [],
    official: false,
    structured: true,
    hazard: 'outage',
    category: 'technology',
    service: page.key,
    language: 'en',
    country: page.country,
    title: `${page.name} outage: ${inc.impact === 'critical' ? 'service largely down' : 'service disrupted'}`,
    // Grounded in the provider's own words; what it affects comes from our page list.
    body: [`${page.name} reports: ${inc.name}.`, components ? `Affected: ${components}.` : `This can affect ${what}.`, update].filter(Boolean).join(' '),
    url: inc.shortlink || page.url,
    publishedAt: new Date(Date.parse(inc.created_at) || now.getTime()).toISOString(),
    lat: area.lat, lon: area.lon, radiusM: area.radiusM, areas: area.areas,
    areaName: area.name,
    officialSeverity: severity,
  };
}

/** One ongoing incident in incident.io's public status-summary API. */
export interface IncidentIoIncident {
  id: string;
  name: string;
  status?: string; // investigating | identified | monitoring
  url?: string;
  published_at?: string;
  last_update_at?: string;
  last_update_message?: string;
  current_worst_impact?: string; // degraded_performance | partial_outage | full_outage
  affected_components?: Array<{ name?: string }>;
}
interface IncidentIoSummary { ongoing_incidents?: IncidentIoIncident[] }

/** incident.io's impact words → Statuspage's: a full outage is "critical", a partial one "major". */
const INCIDENTIO_IMPACT: Record<string, string> = { full_outage: 'critical', partial_outage: 'major', degraded_performance: 'minor' };

/**
 * incident.io summary → the same incident shape as Statuspage, so both share `incidentItem`.
 * A parent page (Square) lists one summary per country sub-page; we read only the one asked for.
 * Throws when the answer has neither shape, so a changed API shows as failing, not as "all fine".
 */
export function incidentIoIncidents(json: unknown, subpage?: string): StatuspageIncident[] {
  const j = json as { subpages?: Array<{ subpage?: string; summary?: IncidentIoSummary }> } & IncidentIoSummary;
  let summary: IncidentIoSummary | undefined;
  if (subpage) summary = j.subpages?.find((s) => s.subpage === subpage)?.summary;
  else summary = j;
  if (!summary || !Array.isArray(summary.ongoing_incidents)) {
    throw new Error(`incident.io summary without ongoing_incidents${subpage ? ` for ${subpage}` : ''}`);
  }
  return summary.ongoing_incidents.map((inc) => ({
    id: inc.id,
    name: inc.name,
    status: inc.status ?? 'investigating',
    impact: INCIDENTIO_IMPACT[inc.current_worst_impact ?? ''] ?? 'none',
    created_at: inc.published_at ?? inc.last_update_at ?? '',
    shortlink: inc.url,
    incident_updates: inc.last_update_message ? [{ body: inc.last_update_message, created_at: inc.last_update_at }] : [],
    components: inc.affected_components ?? [],
  }));
}

export type JsonGetter = (url: string) => Promise<unknown>;

export const jsonGetter: JsonGetter = async (url) => {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
};

/**
 * Polls one status page. Returns new items plus every currently listed id, so incidents that were
 * resolved get an all-clear (pipeline.reconcileFeed).
 */
export async function fetchStatusPage(
  page: StatusPage,
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: JsonGetter = jsonGetter,
  now = new Date(),
): Promise<{ feedKey: string; items: SourceItem[]; listedIds: Set<string> }> {
  const feedKey = `statuspage:${page.key}`;
  const base = page.url.replace(/\/$/, '');
  const incidents = page.api === 'incidentio'
    ? incidentIoIncidents(await get(`${base}/api/v1/summary`), page.subpage)
    : ((await get(`${base}/api/v2/incidents/unresolved.json`)) as { incidents?: StatuspageIncident[] }).incidents ?? [];
  const items: SourceItem[] = [];
  const listedIds = new Set<string>();
  for (const inc of incidents) {
    const item = incidentItem(page, inc, now);
    if (!item) continue;
    listedIds.add(item.externalId);
    for (const r of item.references ?? []) listedIds.add(r);
    if (await isNew(item.externalId)) items.push({ ...item, feedKey });
  }
  return { feedKey, items, listedIds };
}
