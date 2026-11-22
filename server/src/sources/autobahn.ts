import type { SourceItem, Severity } from '../types.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Motorway closures from Die Autobahn GmbH des Bundes (the API behind the Autobahn app):
 * https://verkehr.autobahn.de/o/autobahn, per motorway `/{road}/services/closure` and `/warning`.
 * No published terms; Flori decided on 2026-11-22 to use it with facts only, a link back and an
 * off switch (`AUTOBAHN_URL=off`).
 *
 * Only full closures, category `transit`:
 * - planned full closures of a carriageway (`display_type: CLOSURE`, mostly roadworks at night)
 *   that start within the next 24 hours or started in the last 24 (older long-running ones are known);
 * - traffic messages that say "Vollsperrung" (e.g. after an accident), only Autobahn GmbH's own:
 *   messages with `"source": "inrix"` come from a commercial provider and are never used.
 * Ramp closures, lane closures and jams are left out. Feed by default; a closure may push only
 * near a saved place (rank.ts). Closures that leave the list early get an all-clear.
 */
export const AUTOBAHN_URL = 'https://verkehr.autobahn.de/o/autobahn';
const FEED_KEY = 'autobahn:DE';
const WINDOW_MS = 24 * 3600_000;
/** An accident closure without an end time runs this long from when we first see it; when it leaves the list earlier, it ends then. */
const INCIDENT_MS = 12 * 3600_000;

export interface AutobahnMessage {
  identifier?: string;
  display_type?: string;
  source?: string;
  future?: boolean;
  title?: string;
  subtitle?: string;
  startTimestamp?: string;
  startLcPosition?: string;
  extent?: string;
  coordinate?: { lat: number | string; long: number | string };
  description?: string[];
}

/** "24.11.26" + "21:00" → instant in Berlin time. */
function berlin(d: string, hm: string): string | null {
  const m = d.match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
  const t = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const guess = Date.UTC(year, Number(m[2]) - 1, Number(m[1]), Number(t[1]), Number(t[2]));
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }).format(new Date(guess)));
  return new Date(guess - (((h - Number(t[1])) + 24) % 24) * 3600_000).toISOString();
}

/** Start and end from the text: "Beginn: 23.11.26 um 06:00 Uhr" / "Ende: …", or "24.11.26 21:00 bis zum 25.11.26 05:00 Uhr". */
export function period(m: AutobahnMessage): { start: string | null; end: string | null } {
  const text = (m.description ?? []).join('\n');
  const begin = text.match(/Beginn:\s*(\d{2}\.\d{2}\.\d{2,4})\s*um\s*(\d{1,2}:\d{2})/);
  const end = text.match(/Ende:\s*(\d{2}\.\d{2}\.\d{2,4})\s*um\s*(\d{1,2}:\d{2})/);
  const span = text.match(/(\d{2}\.\d{2}\.\d{2,4})\s+(\d{1,2}:\d{2})\s+bis zum\s+(\d{2}\.\d{2}\.\d{2,4})\s+(\d{1,2}:\d{2})/);
  const ts = m.startTimestamp && !Number.isNaN(Date.parse(m.startTimestamp)) ? new Date(m.startTimestamp).toISOString() : null;
  return {
    start: ts ?? (begin ? berlin(begin[1], begin[2]) : span ? berlin(span[1], span[2]) : null),
    end: end ? berlin(end[1], end[2]) : span ? berlin(span[3], span[4]) : null,
  };
}

/** Stable across versions: the identifier changes its timestamps with each update, its first part doesn't. */
export const messageId = (road: string, m: AutobahnMessage) => `autobahn:${road}:${(m.identifier ?? '').split('--')[0]}:${m.startLcPosition ?? ''}`;

/** Closed for lorries only ("Sperrung für Schwerlastverkehr max. 44to") is not a closure for everyone. */
const LORRIES_ONLY = /schwerlast|\blkw\b|\b\d+\s*(t|to|tonnen)\b/i;
export const isFullClosure = (m: AutobahnMessage) =>
  m.display_type === 'CLOSURE' && m.source !== 'inrix' && !LORRIES_ONLY.test(`${m.title ?? ''} ${m.subtitle ?? ''}`);

export const isFullClosureWarning = (m: AutobahnMessage) =>
  m.source !== 'inrix' && !/^INRIX/i.test(m.identifier ?? '') && (m.description ?? []).some((l) => /\bVollsperrung\b/i.test(l));

const time = (iso: string) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(',', '');

export function toSourceItem(road: string, m: AutobahnMessage, kind: 'closure' | 'warning', now: Date): SourceItem | null {
  const lat = Number(m.coordinate?.lat), lon = Number(m.coordinate?.long);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const { start, end } = period(m);
  if (!start) return null;
  // "A100 | Halenseestraße - Funkturm" → "Halenseestraße – Funkturm"; direction from " Wilmersdorf -> Wedding".
  const parts = [...new Set((m.title ?? '').replace(/^\s*A\d+\s*\|\s*/, '').split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean))];
  const section = parts.join(' – '); // "Köln-Nord - Köln-Nord" → "Köln-Nord"
  const toward = (m.subtitle ?? '').split('->')[1]?.trim();
  const incident = kind === 'warning';
  // Without an end time: a day for planned closures; an accident closure 12 hours from now, and the
  // first poll that no longer lists it ends it (with an all-clear for people who had a push).
  const endsAt = end ?? new Date(incident ? now.getTime() + INCIDENT_MS : Date.parse(start) + WINDOW_MS).toISOString();
  if (Date.parse(endsAt) <= now.getTime()) return null;
  const titleBase = `${road} gesperrt`;
  const title = section && `${titleBase}: ${section}`.length <= 50 ? `${titleBase}: ${section}` : section ? `${titleBase}: ${section.slice(0, 50 - titleBase.length - 3).trimEnd()}…` : titleBase;
  const why = incident
    ? (m.description ?? []).map((l) => l.replace(/^-\s*/, '').trim()).find((l) => /unfall|bergung|fahrzeugbrand|gefahr|personen|tiere/i.test(l))
    : 'Baustelle';
  const body = [
    `Vollsperrung${toward ? ` Richtung ${toward}` : ''}`,
    incident ? `${why ? ` (${why})` : ''}, seit ${time(start)} Uhr.` : `, ${time(start)} bis ${end ? `${time(end)} Uhr` : 'auf Weiteres'} (${why}).`,
    ' Umleitung beachten. Quelle: Die Autobahn GmbH.',
  ].join('');
  // A circle around the closed section (the extent is "lat,lon,lat,lon").
  const ext = (m.extent ?? '').split(',').map(Number);
  const spanM = ext.length === 4 && ext.every(Number.isFinite) ? Math.hypot((ext[0] - ext[2]) * 111_000, (ext[1] - ext[3]) * 70_000) / 2 : 0;
  return {
    source: 'autobahn',
    sourceName: 'Die Autobahn GmbH · Sperrungen',
    externalId: messageId(road, m),
    feedKey: FEED_KEY,
    official: true,
    structured: true,
    hazard: 'road_closure',
    category: 'transit',
    language: 'de',
    country: 'DE',
    title,
    body,
    url: 'https://verkehr.autobahn.de/',
    publishedAt: new Date(Math.min(Date.parse(start), now.getTime())).toISOString(),
    ...(Date.parse(start) > now.getTime() ? { onsetAt: start } : {}),
    expiresAt: endsAt,
    lat, lon, radiusM: Math.round(spanM + 1000),
    areaName: `${road}${section ? ` ${section}` : ''}`,
    officialSeverity: (incident ? 2 : 1) as Severity,
  };
}

/** Planned closures we tell people about: starting within 24 h, or started in the last 24 h. */
const freshClosure = (m: AutobahnMessage, now: Date) => {
  if (!isFullClosure(m)) return false;
  const { start } = period(m);
  return !!start && Math.abs(Date.parse(start) - now.getTime()) <= WINDOW_MS;
};

type Get = (url: string) => Promise<unknown>;
const defaultGet: Get = async (url) => {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'HeyOkay/0.1 (safety alerts; contact via app)' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
};

/**
 * Every motorway's closures and messages (~230 small requests, 4 at a time). If any road fails
 * twice, the whole poll fails: a missing road must not look like "all closures lifted".
 */
export async function fetchAutobahn(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: Get = defaultGet,
  opts: { now?: Date; url?: string; concurrency?: number } = {},
): Promise<{ feedKey: string; items: SourceItem[]; listedIds: Set<string> }> {
  const now = opts.now ?? new Date();
  const base = opts.url ?? AUTOBAHN_URL;
  const list = (await get(`${base}/`)) as { roads?: string[] };
  if (!Array.isArray(list?.roads) || !list.roads.length) throw new Error('Autobahn: no list of roads');
  const roads = [...new Set(list.roads.map((r) => r.trim()).filter((r) => /^A\d+$/.test(r)))];
  const jobs = roads.flatMap((road) => (['closure', 'warning'] as const).map((kind) => ({ road, kind })));
  const found: { road: string; kind: 'closure' | 'warning'; m: AutobahnMessage }[] = [];
  // Everything still listed, also long-running closures we no longer announce: what's missing was lifted.
  const listedIds = new Set<string>();
  const once = async (url: string) => { try { return await get(url); } catch { return get(url); } };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { road, kind } = jobs[next++];
      const json = (await once(`${base}/${road}/services/${kind}`)) as Record<string, AutobahnMessage[]>;
      const msgs = json?.[kind];
      if (!Array.isArray(msgs)) throw new Error(`Autobahn ${road}/${kind}: unexpected format`);
      for (const m of msgs) {
        const full = kind === 'closure' ? isFullClosure(m) : isFullClosureWarning(m);
        if (!full) continue;
        listedIds.add(messageId(road, m));
        if (kind === 'warning' || freshClosure(m, now)) found.push({ road, kind, m });
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  const items: SourceItem[] = [];
  for (const { road, kind, m } of found) {
    const item = toSourceItem(road, m, kind, now);
    if (!item) continue;
    if (await isNew(item.externalId)) items.push(item);
  }
  return { feedKey: FEED_KEY, items, listedIds };
}
