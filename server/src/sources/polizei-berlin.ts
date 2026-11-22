import type { SourceItem } from '../types.js';
import { stripHtml } from './nina.js';
import { isNeverAnAlert, textFetch, type TextFetcher } from './presseportal.js';

/**
 * Polizei Berlin press releases ("Polizeimeldungen"), from the RSS feed on berlin.de
 * (https://www.berlin.de/polizei/polizeimeldungen/). Polizei Berlin doesn't publish on Presseportal.
 *
 * The feed carries only titles, so each new release's page is fetched once: it names the
 * district ("Ereignisort", e.g. "Steglitz-Zehlendorf") and has the full text. The district and
 * "Berlin" become the place line for the extractor; releases it can't place more precisely than
 * the district or city wait at the Alert Desk, as with every police source.
 *
 * The feed also lists public appeals (missing persons, unidentified dead, wanted persons) and
 * court news; those are dropped before any model call. Like Presseportal, the text is only used
 * to extract the facts; people see our own short alert and a link to the release.
 */
export const POLIZEI_BERLIN_URL = 'https://www.berlin.de/polizei/polizeimeldungen/index.php/rss';
export const POLIZEI_BERLIN_AREA = { name: 'Berlin', lat: 52.52, lon: 13.405, radiusM: 20000 };
const SOURCE_NAME = 'Polizei Berlin';
const MAX_AGE_H = 12;
const MAX_ARTICLES_PER_POLL = 8;

/** On top of the Presseportal filter: appeals about the dead, people found again, verdicts, prevention campaigns. */
const NOT_AN_ALERT_BERLIN = /\b(unbekannte[rn]? tote[rn]?|wieder da|wieder aufgetaucht|urteil\w*|verurteil\w*|prozess\w*|präventions\w*|prävention|bilanz)\b/i;

export function isNeverAnAlertBerlin(title: string) {
  return isNeverAnAlert(title) || NOT_AN_ALERT_BERLIN.test(title);
}

export interface BerlinEntry { id: string; title: string; url: string; publishedAt: string }

export function parseBerlinFeed(xml: string): BerlinEntry[] {
  const out: BerlinEntry[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const url = tag(b, 'link');
    const id = url.match(/pressemitteilung\.(\d+)\.php/)?.[1];
    if (!id) continue;
    const date = tag(b, 'pubDate');
    out.push({
      id,
      title: decode(stripHtml(tag(b, 'title'))).replace(/\s+/g, ' ').trim(),
      url: url.startsWith('http') ? url : `https://www.berlin.de${url}`,
      publishedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date().toISOString(),
    });
  }
  return out;
}

export interface BerlinArticle { district: string | null; text: string }

/** District and text from a release page; null when the page doesn't look like a release. */
export function parseBerlinArticle(html: string): BerlinArticle | null {
  const start = html.indexOf('id="layout-grid__area--maincontent"');
  if (start < 0) return null;
  const endAt = html.indexOf('id="layout-grid__area--marginal"', start);
  const main = html.slice(start, endAt < 0 ? undefined : endAt);
  const district = main.match(/<p class="polizeimeldung" title="Ereignisort">([\s\S]*?)<\/p>/)?.[1];
  const paras = [...main.matchAll(/<div class="textile">([\s\S]*?)<\/div>/gi)]
    .flatMap((d) => [...d[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((p) => p[1]))
    // "Nr. 1557" is the release number, not text.
    .map((p) => decode(stripHtml(p.replace(/<strong>\s*Nr\.\s*\d+\s*<\/strong>\s*(<br\s*\/?>)?/i, ''))).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!paras.length) return null;
  return { district: district ? decode(stripHtml(district)).trim() || null : null, text: paras.join('\n\n') };
}

export function toSourceItem(e: BerlinEntry, a: BerlinArticle | null): SourceItem {
  const district = a?.district;
  return {
    source: 'rss',
    sourceName: SOURCE_NAME,
    externalId: `polizei-berlin:${e.id}`,
    official: false,
    title: e.title,
    body: `${district ? `Ort: ${district}, Berlin\n\n` : ''}${a?.text ?? e.title}`,
    url: e.url,
    publishedAt: e.publishedAt,
    category: 'crime',
    language: 'de',
    country: 'DE',
  };
}

/** New releases from the last 12 hours, at most 8 article pages per poll (the rest come next poll). */
export async function fetchPolizeiBerlin(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: TextFetcher = textFetch,
  opts: { now?: Date; maxAgeH?: number; maxArticles?: number } = {},
): Promise<SourceItem[]> {
  const now = (opts.now ?? new Date()).getTime();
  const maxAgeMs = (opts.maxAgeH ?? MAX_AGE_H) * 3600_000;
  let articles = opts.maxArticles ?? MAX_ARTICLES_PER_POLL;
  const out: SourceItem[] = [];
  for (const e of parseBerlinFeed(await get(POLIZEI_BERLIN_URL))) {
    if (isNeverAnAlertBerlin(e.title)) continue;
    if (now - Date.parse(e.publishedAt) > maxAgeMs) continue;
    const id = `polizei-berlin:${e.id}`;
    if (!(await isNew(id))) continue;
    if (articles-- <= 0) break;
    let article: BerlinArticle | null = null;
    try {
      article = parseBerlinArticle(await get(e.url));
    } catch (err) {
      console.warn(`[polizei-berlin] ${e.id}:`, (err as Error).message);
    }
    // Without the page there's only a title: not enough to place or judge it. Try again next poll.
    if (!article) continue;
    out.push(toSourceItem(e, article));
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
    .replace(/&nbsp;/g, ' ').replace(/&shy;/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
