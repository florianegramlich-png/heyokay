import type { SourceItem } from '../types.js';
import { stripHtml } from './nina.js';

/**
 * Berliner Feuerwehr incident reports ("Einsätze"), from the RSS feed the fire brigade publishes
 * (https://www.berliner-feuerwehr.de/service/rss-feeds/). Each report names the street and
 * district ("Straße: …", "Ortsteil: …"), which become the place hint for the extractor.
 * Their press-information feed is left out: it carries announcements, not incidents.
 */
export const FEUERWEHR_BERLIN_URL = 'https://www.berliner-feuerwehr.de/einsaetze.xml';
export const FEUERWEHR_BERLIN_AREA = { name: 'Berlin', lat: 52.52, lon: 13.405, radiusM: 20000 };
const SOURCE_NAME = 'Berliner Feuerwehr';

/** Lines that describe the operation, not the situation: units deployed, partners, photo credit, author initials. */
const META = /^(eingesetzt\w*|eingesetzte kräfte|vor ort|bildmaterial|foto|fotos|text)\b|^\(\w{1,4}\)$/i;

export interface FireReport { id: string; title: string; url: string; publishedAt: string; street: string | null; district: string | null; text: string }

export function parseReports(xml: string): FireReport[] {
  const out: FireReport[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const guid = tag(b, 'guid');
    const id = guid.match(/(\d+)\s*$/)?.[1];
    if (!id) continue;
    const date = tag(b, 'pubDate');
    let street: string | null = null, district: string | null = null;
    const paras: string[] = [];
    // One paragraph can hold several lines separated by <br>.
    const lines = [...tag(b, 'content:encoded').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .flatMap((p) => decode(stripHtml(p[1])).split('\n'))
      .map((l) => l.replace(/\s+/g, ' ').trim());
    for (const line of lines) {
      if (!line) continue;
      const field = line.match(/^(straße|ortsteil)\s*:\s*(.+)$/i);
      if (field) {
        if (field[1].toLowerCase() === 'straße') street = field[2].trim(); else district = field[2].trim();
        continue;
      }
      if (META.test(line)) continue;
      paras.push(line);
    }
    out.push({
      id,
      title: decode(stripHtml(tag(b, 'title'))).trim(),
      url: tag(b, 'link'),
      publishedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date().toISOString(),
      street, district,
      text: paras.length ? paras.join('\n\n') : decode(stripHtml(tag(b, 'description'))),
    });
  }
  return out;
}

export function toSourceItem(r: FireReport): SourceItem {
  const place = [r.street, r.district, 'Berlin'].filter(Boolean).join(', ');
  return {
    source: 'rss',
    sourceName: SOURCE_NAME,
    externalId: `feuerwehr-berlin:${r.id}`,
    official: false,
    title: r.title,
    // The place line first, so the extractor (and the keyword fallback) sees street and district.
    body: `${r.street || r.district ? `Ort: ${place}\n\n` : ''}${r.text}`,
    url: r.url || undefined,
    publishedAt: r.publishedAt,
    category: 'public_safety',
    language: 'de',
  };
}

export async function fetchFeuerwehrBerlin(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: (url: string) => Promise<string> = async (url) => {
    const res = await fetch(url, { headers: { Accept: 'application/rss+xml, text/xml' } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.text();
  },
): Promise<SourceItem[]> {
  const out: SourceItem[] = [];
  for (const r of parseReports(await get(FEUERWEHR_BERLIN_URL))) {
    const item = toSourceItem(r);
    if (await isNew(item.externalId)) out.push(item);
  }
  return out;
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!m) return '';
  return m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
