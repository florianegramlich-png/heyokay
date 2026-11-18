import type { Category, SourceItem } from '../types.js';
import { stripHtml } from './nina.js';

/**
 * Presseportal "Blaulicht": police and fire brigade press releases, one RSS feed per agency
 * (https://www.presseportal.de/blaulicht/). The feed carries only a teaser, so for each item
 * not seen before the article page is fetched once for the full text.
 *
 * Agencies are an approved list (below), never discovered. Each one maps to a city area that
 * is used when the text names no place the geocoder can resolve.
 * Polizei Berlin, Feuerwehr Berlin and Polizei München don't publish on Presseportal
 * (Berlin: berlin.de feeds; München: polizei.bayern.de).
 */
export const PRESSEPORTAL_BASE = 'https://www.presseportal.de';

export interface PresseportalAgency {
  /** Presseportal newsroom id (presseportal.de/blaulicht/nr/<id>). */
  id: number;
  name: string;
  /** Config key, e.g. "polizei-hamburg". */
  key: string;
  city: 'Berlin' | 'München' | 'Hamburg' | 'Köln';
  categoryHint: Category;
  area: { name: string; lat: number; lon: number; radiusM: number };
}

const AREA = {
  Berlin: { name: 'Berlin', lat: 52.52, lon: 13.405, radiusM: 20000 },
  München: { name: 'München', lat: 48.1374, lon: 11.5755, radiusM: 15000 },
  Hamburg: { name: 'Hamburg', lat: 53.5511, lon: 9.9937, radiusM: 18000 },
  Köln: { name: 'Köln', lat: 50.9375, lon: 6.9603, radiusM: 13000 },
} as const;

/** Newsroom ids checked against presseportal.de on 2026-11-18. */
export const PRESSEPORTAL_AGENCIES: PresseportalAgency[] = [
  { id: 70238, key: 'bundespolizei-berlin', name: 'Bundespolizeidirektion Berlin', city: 'Berlin', categoryHint: 'public_safety', area: AREA.Berlin },
  { id: 64017, key: 'bundespolizei-muenchen', name: 'Bundespolizeidirektion München', city: 'München', categoryHint: 'public_safety', area: AREA.München },
  { id: 131419, key: 'feuerwehr-muenchen', name: 'Feuerwehr München', city: 'München', categoryHint: 'public_safety', area: AREA.München },
  { id: 6337, key: 'polizei-hamburg', name: 'Polizei Hamburg', city: 'Hamburg', categoryHint: 'crime', area: AREA.Hamburg },
  { id: 82522, key: 'feuerwehr-hamburg', name: 'Feuerwehr Hamburg', city: 'Hamburg', categoryHint: 'public_safety', area: AREA.Hamburg },
  { id: 70254, key: 'bundespolizei-hamburg', name: 'Bundespolizeiinspektion Hamburg', city: 'Hamburg', categoryHint: 'public_safety', area: AREA.Hamburg },
  { id: 12415, key: 'polizei-koeln', name: 'Polizei Köln', city: 'Köln', categoryHint: 'crime', area: AREA.Köln },
  { id: 115889, key: 'feuerwehr-koeln', name: 'Feuerwehr Köln', city: 'Köln', categoryHint: 'public_safety', area: AREA.Köln },
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

export function feedUrl(agency: PresseportalAgency) {
  return `${PRESSEPORTAL_BASE}/rss/dienststelle_${agency.id}.rss2`;
}

/**
 * Releases that are never an alert, dropped before any model call: missing-person searches
 * (personal data, often about minors), closed searches and station openings or ceremonies.
 * Witness appeals and past incidents are left to the extractor, which already drops them.
 */
const NOT_AN_ALERT = /\b(vermisst\w*|vermisstenfahndung|erledigung|eingeweiht|einweihung|eröffnung|neue wache|richtfest|jubiläum|ehrung|nachwuchs|ausbildungsstart|tag der offenen tür)\b/i;

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
  const res = await fetch(url, { headers: { Accept: 'text/html, application/rss+xml, text/xml', 'User-Agent': 'HeyOkay/0.1 (safety alerts; contact via app)' } });
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
): Promise<SourceItem[]> {
  const entries = parseAgencyFeed(await get(feedUrl(agency)));
  const out: SourceItem[] = [];
  for (const e of entries) {
    if (NOT_AN_ALERT.test(e.title)) continue;
    const id = externalId(e.pmId);
    if (!(await isNew(id))) continue;
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
