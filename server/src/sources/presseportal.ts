import type { Category, SourceItem } from '../types.js';
import { stripHtml } from './nina.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Presseportal "Blaulicht": police and fire brigade press releases, one RSS feed per agency
 * (https://www.presseportal.de/blaulicht/). The feed carries only a teaser, so for each item
 * not seen before the article page is fetched once for the full text.
 *
 * Agencies are an approved list (below), never discovered. Each one maps to a city area that
 * is used when the text names no place the geocoder can resolve.
 * Polizei Berlin, Feuerwehr Berlin and Polizei München don't publish on Presseportal
 * (Berlin: berlin.de feeds; München: polizei.bayern.de), nor do Saxony's police (Leipzig,
 * Dresden: polizei.sachsen.de) or Polizei Augsburg (polizei.bayern.de).
 * Several police headquarters cover more than their city (Polizeipräsidium Mittelfranken,
 * Mannheim, Polizeidirektion Hannover …): the area is only the fallback for releases that name
 * no place the geocoder resolves, and those wait at the Alert Desk anyway.
 */
export const PRESSEPORTAL_BASE = 'https://www.presseportal.de';

export interface PresseportalAgency {
  /** Presseportal newsroom id (presseportal.de/blaulicht/nr/<id>). */
  id: number;
  name: string;
  /** Config key, e.g. "polizei-hamburg". */
  key: string;
  city: City;
  categoryHint: Category;
  area: { name: string; lat: number; lon: number; radiusM: number };
}

const AREA = {
  Berlin: { name: 'Berlin', lat: 52.52, lon: 13.405, radiusM: 20000 },
  München: { name: 'München', lat: 48.1374, lon: 11.5755, radiusM: 15000 },
  Hamburg: { name: 'Hamburg', lat: 53.5511, lon: 9.9937, radiusM: 18000 },
  Köln: { name: 'Köln', lat: 50.9375, lon: 6.9603, radiusM: 13000 },
  Frankfurt: { name: 'Frankfurt am Main', lat: 50.1109, lon: 8.6821, radiusM: 13000 },
  Stuttgart: { name: 'Stuttgart', lat: 48.7758, lon: 9.1829, radiusM: 12000 },
  Düsseldorf: { name: 'Düsseldorf', lat: 51.2277, lon: 6.7735, radiusM: 11000 },
  Dortmund: { name: 'Dortmund', lat: 51.5136, lon: 7.4653, radiusM: 13000 },
  Essen: { name: 'Essen', lat: 51.4556, lon: 7.0116, radiusM: 12000 },
  Bremen: { name: 'Bremen', lat: 53.0793, lon: 8.8017, radiusM: 14000 },
  Hannover: { name: 'Hannover', lat: 52.3759, lon: 9.732, radiusM: 14000 },
  Nürnberg: { name: 'Nürnberg', lat: 49.4521, lon: 11.0767, radiusM: 12000 },
  Duisburg: { name: 'Duisburg', lat: 51.4344, lon: 6.7623, radiusM: 13000 },
  Bochum: { name: 'Bochum', lat: 51.4818, lon: 7.2162, radiusM: 11000 },
  Wuppertal: { name: 'Wuppertal', lat: 51.2562, lon: 7.1508, radiusM: 11000 },
  Bielefeld: { name: 'Bielefeld', lat: 52.0302, lon: 8.5325, radiusM: 11000 },
  Bonn: { name: 'Bonn', lat: 50.7374, lon: 7.0982, radiusM: 10000 },
  Münster: { name: 'Münster', lat: 51.9607, lon: 7.6261, radiusM: 12000 },
  Mannheim: { name: 'Mannheim', lat: 49.4875, lon: 8.466, radiusM: 11000 },
  Karlsruhe: { name: 'Karlsruhe', lat: 49.0069, lon: 8.4037, radiusM: 11000 },
  Wiesbaden: { name: 'Wiesbaden', lat: 50.0782, lon: 8.2398, radiusM: 10000 },
  Gelsenkirchen: { name: 'Gelsenkirchen', lat: 51.5177, lon: 7.0857, radiusM: 9000 },
  Aachen: { name: 'Aachen', lat: 50.7753, lon: 6.0839, radiusM: 10000 },
  Mönchengladbach: { name: 'Mönchengladbach', lat: 51.1805, lon: 6.4428, radiusM: 10000 },
  Kiel: { name: 'Kiel', lat: 54.3233, lon: 10.1228, radiusM: 10000 },
  Braunschweig: { name: 'Braunschweig', lat: 52.2689, lon: 10.5268, radiusM: 10000 },
  Krefeld: { name: 'Krefeld', lat: 51.3388, lon: 6.5853, radiusM: 9000 },
  Oberhausen: { name: 'Oberhausen', lat: 51.4963, lon: 6.8638, radiusM: 8000 },
} as const;

export type City = keyof typeof AREA;

/** Newsroom ids checked against presseportal.de on 2026-11-18 (first 9) and 2026-11-22 (city police). */
export const PRESSEPORTAL_AGENCIES: PresseportalAgency[] = [
  { id: 70238, key: 'bundespolizei-berlin', name: 'Bundespolizeidirektion Berlin', city: 'Berlin', categoryHint: 'public_safety', area: AREA.Berlin },
  { id: 64017, key: 'bundespolizei-muenchen', name: 'Bundespolizeidirektion München', city: 'München', categoryHint: 'public_safety', area: AREA.München },
  { id: 131419, key: 'feuerwehr-muenchen', name: 'Feuerwehr München', city: 'München', categoryHint: 'public_safety', area: AREA.München },
  { id: 6337, key: 'polizei-hamburg', name: 'Polizei Hamburg', city: 'Hamburg', categoryHint: 'crime', area: AREA.Hamburg },
  { id: 82522, key: 'feuerwehr-hamburg', name: 'Feuerwehr Hamburg', city: 'Hamburg', categoryHint: 'public_safety', area: AREA.Hamburg },
  { id: 70254, key: 'bundespolizei-hamburg', name: 'Bundespolizeiinspektion Hamburg', city: 'Hamburg', categoryHint: 'public_safety', area: AREA.Hamburg },
  { id: 12415, key: 'polizei-koeln', name: 'Polizei Köln', city: 'Köln', categoryHint: 'crime', area: AREA.Köln },
  { id: 115889, key: 'feuerwehr-koeln', name: 'Feuerwehr Köln', city: 'Köln', categoryHint: 'public_safety', area: AREA.Köln },
  // City police headquarters, the 20 largest cities that publish here (checked 2026-11-22).
  { id: 4970, key: 'polizei-frankfurt', name: 'Polizeipräsidium Frankfurt am Main', city: 'Frankfurt', categoryHint: 'crime', area: AREA.Frankfurt },
  { id: 110977, key: 'polizei-stuttgart', name: 'Polizeipräsidium Stuttgart', city: 'Stuttgart', categoryHint: 'crime', area: AREA.Stuttgart },
  { id: 13248, key: 'polizei-duesseldorf', name: 'Polizei Düsseldorf', city: 'Düsseldorf', categoryHint: 'crime', area: AREA.Düsseldorf },
  { id: 4971, key: 'polizei-dortmund', name: 'Polizei Dortmund', city: 'Dortmund', categoryHint: 'crime', area: AREA.Dortmund },
  { id: 11562, key: 'polizei-essen', name: 'Polizei Essen', city: 'Essen', categoryHint: 'crime', area: AREA.Essen },
  { id: 35235, key: 'polizei-bremen', name: 'Polizei Bremen', city: 'Bremen', categoryHint: 'crime', area: AREA.Bremen },
  { id: 66841, key: 'polizei-hannover', name: 'Polizeidirektion Hannover', city: 'Hannover', categoryHint: 'crime', area: AREA.Hannover },
  { id: 6013, key: 'polizei-mittelfranken', name: 'Polizeipräsidium Mittelfranken', city: 'Nürnberg', categoryHint: 'crime', area: AREA.Nürnberg },
  { id: 50510, key: 'polizei-duisburg', name: 'Polizei Duisburg', city: 'Duisburg', categoryHint: 'crime', area: AREA.Duisburg },
  { id: 11530, key: 'polizei-bochum', name: 'Polizei Bochum', city: 'Bochum', categoryHint: 'crime', area: AREA.Bochum },
  { id: 11811, key: 'polizei-wuppertal', name: 'Polizei Wuppertal', city: 'Wuppertal', categoryHint: 'crime', area: AREA.Wuppertal },
  { id: 12522, key: 'polizei-bielefeld', name: 'Polizei Bielefeld', city: 'Bielefeld', categoryHint: 'crime', area: AREA.Bielefeld },
  { id: 7304, key: 'polizei-bonn', name: 'Polizei Bonn', city: 'Bonn', categoryHint: 'crime', area: AREA.Bonn },
  { id: 11187, key: 'polizei-muenster', name: 'Polizei Münster', city: 'Münster', categoryHint: 'crime', area: AREA.Münster },
  { id: 14915, key: 'polizei-mannheim', name: 'Polizeipräsidium Mannheim', city: 'Mannheim', categoryHint: 'crime', area: AREA.Mannheim },
  { id: 110972, key: 'polizei-karlsruhe', name: 'Polizeipräsidium Karlsruhe', city: 'Karlsruhe', categoryHint: 'crime', area: AREA.Karlsruhe },
  { id: 43562, key: 'polizei-wiesbaden', name: 'Polizeipräsidium Westhessen (Wiesbaden)', city: 'Wiesbaden', categoryHint: 'crime', area: AREA.Wiesbaden },
  { id: 51056, key: 'polizei-gelsenkirchen', name: 'Polizei Gelsenkirchen', city: 'Gelsenkirchen', categoryHint: 'crime', area: AREA.Gelsenkirchen },
  { id: 11559, key: 'polizei-aachen', name: 'Polizei Aachen', city: 'Aachen', categoryHint: 'crime', area: AREA.Aachen },
  { id: 30127, key: 'polizei-moenchengladbach', name: 'Polizei Mönchengladbach', city: 'Mönchengladbach', categoryHint: 'crime', area: AREA.Mönchengladbach },
  { id: 14626, key: 'polizei-kiel', name: 'Polizeidirektion Kiel', city: 'Kiel', categoryHint: 'crime', area: AREA.Kiel },
  { id: 11554, key: 'polizei-braunschweig', name: 'Polizei Braunschweig', city: 'Braunschweig', categoryHint: 'crime', area: AREA.Braunschweig },
  { id: 50667, key: 'polizei-krefeld', name: 'Polizeipräsidium Krefeld', city: 'Krefeld', categoryHint: 'crime', area: AREA.Krefeld },
  { id: 62138, key: 'polizei-oberhausen', name: 'Polizeipräsidium Oberhausen', city: 'Oberhausen', categoryHint: 'crime', area: AREA.Oberhausen },
];

/** `PRESSEPORTAL_AGENCIES` env: "all" (default), "off", or a comma list of keys or newsroom ids. */
export function selectAgencies(spec: string | undefined): PresseportalAgency[] {
  const s = (spec ?? 'all').trim().toLowerCase();
  if (s === 'all' || s === '') return PRESSEPORTAL_AGENCIES;
  if (s === 'off' || s === 'none') return [];
  const wanted = s.split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !PRESSEPORTAL_AGENCIES.some((a) => a.key === w || String(a.id) === w));
  if (unknown.length) throw new Error(`PRESSEPORTAL_AGENCIES: unknown agency ${unknown.join(', ')} (known: ${PRESSEPORTAL_AGENCIES.map((a) => a.key).join(', ')})`);
  return PRESSEPORTAL_AGENCIES.filter((a) => wanted.includes(a.key) || wanted.includes(String(a.id)));
}

/** Same limit as the extractor's: older press releases are history, not alerts. */
const MAX_AGE_H = 12;
/** Article pages fetched per agency and poll. New releases are a few a day, so this only bites after downtime. */
const MAX_ARTICLES_PER_POLL = 5;

export function feedUrl(agency: PresseportalAgency) {
  return `${PRESSEPORTAL_BASE}/rss/dienststelle_${agency.id}.rss2`;
}

/**
 * Releases that are never an alert, dropped before any model call: missing-person searches
 * (personal data, often about minors) and public manhunts with names or photos, closed searches,
 * station openings, ceremonies, press invitations and weekly statistics.
 * Witness appeals and past incidents are left to the extractor, which already drops them.
 */
const NOT_AN_ALERT = /\b(vermisst\w*|vermisstenfahndung|\w*ffentlichkeitsfahndung|wohlbehalten|gesuchte[rn]? \d+-jährige\w*|führungswechsel|medienvertreter\w*|\w*einbruchsradar|mobile wache|erledigung|eingeweiht|einweihung|eröffnung|neue wache|richtfest|jubiläum|ehrung|nachwuchs|ausbildungsstart|tag der offenen tür)\b/i;

export interface FeedEntry { title: string; teaser: string; url: string; pmId: string; publishedAt: string }

/** Parses one agency feed. */
export function parseAgencyFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const url = tag(b, 'link') || tag(b, 'guid');
    const pm = url.match(/\/blaulicht\/pm\/(\d+)\/(\d+)/);
    if (!pm) continue;
    const date = tag(b, 'pubDate');
    out.push({
      title: cleanTitle(decode(tag(b, 'title'))),
      teaser: decode(stripHtml(tag(b, 'description'))),
      url,
      pmId: `${pm[1]}/${pm[2]}`,
      publishedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date().toISOString(),
    });
  }
  return out;
}

/** "POL-HH: 261118-3. Zeugenaufruf …" → "Zeugenaufruf …"; "POL-F: 261118 - 1342 Frankfurt - Nordend …" → "Frankfurt - Nordend …". */
export function cleanTitle(t: string): string {
  return t
    // Agency prefix: "POL-HH:", "FW-M:", "FW Köln:", "Bundespolizeidirektion München:"
    .replace(/^(?:[A-ZÄÖÜ]{2,6}(?:-[A-Za-zÄÖÜäöü0-9]+)*|FW [A-ZÄÖÜ][a-zäöü]+|Bundespolizei[a-zäöü]*(?: [A-ZÄÖÜ][a-zäöü]+)?):\s*/, '')
    // Release number: "261118-3.", "261118 - 1342", "261118-3-K/LEV"
    .replace(/^\d{6}\s*[-–]\s*\d+(?:-[A-ZÄÖÜ/]+)?\.?\s*/, '')
    // Kiel "261120.3", Mittelfranken "(973)", Karlsruhe "(KA)", Bremen "Nr.: 0734", Wuppertal "W" / "SG" / "RS"
    .replace(/^\d{6}\.\d+\s*/, '')
    .replace(/^\((?:\d+|[A-ZÄÖÜ]{1,4})\)\s*/, '')
    .replace(/^Nr\.:?\s*\d+\s*/, '')
    .replace(/^(?:W|SG|RS)\s+(?=[A-ZÄÖÜ])/, '')
    // Bremen wraps the headline: "--Schüsse in Gröpelingen--"
    .replace(/^-{2,}\s*(.*?)\s*-{2,}$/, '$1')
    .trim();
}

/** Full text from an article page: the paragraphs after the "(ots)" line, up to the press-office contact block. */
export function parseArticle(html: string): string | null {
  const start = html.indexOf('<article');
  if (start < 0) return null;
  const end = html.indexOf('</article>', start);
  const article = html.slice(start, end < 0 ? undefined : end);
  const paras = [...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((p) => decode(stripHtml(p[1])).replace(/\s+/g, ' ').trim());
  const ots = paras.findIndex((p) => /\(ots\)/.test(p));
  if (ots < 0) return null;
  const body: string[] = [];
  for (const p of paras.slice(ots + 1)) {
    if (/^(rückfragen\b|original-content von)/i.test(p)) break;
    if (/^schneller informiert\b/i.test(p)) continue; // channel promotion
    if (p) body.push(p);
  }
  return body.length ? body.join('\n\n') : null;
}

export type TextFetcher = (url: string) => Promise<string>;

export const textFetch: TextFetcher = async (url) => {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'text/html, application/rss+xml, text/xml', 'User-Agent': 'HeyOkay/0.1 (safety alerts; contact via app)' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
};

export function externalId(pmId: string) {
  return `presseportal:${pmId}`;
}

/**
 * Poll one agency. Only items not seen before (`isNew`) get their article page fetched;
 * if that fails, the teaser is used. Items that are never an alert are skipped.
 */
export async function fetchAgency(
  agency: PresseportalAgency,
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: TextFetcher = textFetch,
  opts: { now?: Date; maxAgeH?: number; maxArticles?: number } = {},
): Promise<SourceItem[]> {
  const now = (opts.now ?? new Date()).getTime();
  const maxAgeMs = (opts.maxAgeH ?? MAX_AGE_H) * 3600_000;
  let articles = opts.maxArticles ?? MAX_ARTICLES_PER_POLL;
  const entries = parseAgencyFeed(await get(feedUrl(agency)));
  const out: SourceItem[] = [];
  for (const e of entries) {
    if (NOT_AN_ALERT.test(e.title)) continue;
    // Older releases would be dropped as history anyway: don't fetch their articles.
    if (now - Date.parse(e.publishedAt) > maxAgeMs) continue;
    const id = externalId(e.pmId);
    if (!(await isNew(id))) continue;
    // A few articles per poll and agency at most; the rest come next poll (or keep their teaser).
    if (articles <= 0) break;
    articles--;
    let body = e.teaser;
    try {
      body = parseArticle(await get(e.url)) ?? e.teaser;
    } catch (err) {
      console.warn(`[presseportal] ${agency.key} ${e.pmId}:`, (err as Error).message);
    }
    out.push({
      source: 'presseportal',
      sourceName: agency.name,
      externalId: id,
      official: false,
      title: e.title,
      body,
      url: e.url,
      publishedAt: e.publishedAt,
      category: agency.categoryHint,
      language: 'de',
      country: 'DE',
    });
  }
  return out;
}

export function isNeverAnAlert(title: string) {
  return NOT_AN_ALERT.test(title);
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ndash: '–', mdash: '—', bdquo: '„', ldquo: '“', rdquo: '”', euro: '€' };

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? m);
}
