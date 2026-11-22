import type { SourceItem } from '../types.js';
import { stripHtml } from './nina.js';
import { fetchWithTimeout } from '../http.js';
import { DE_STATES } from '../data/de-states.js';

/**
 * Product and food recalls in Germany: lebensmittelwarnung.de, the joint portal of the Länder and
 * the Federal Office of Consumer Protection (BVL). Its RSS feed lists every current warning
 * (food, cosmetics, consumer goods, baby and children's products, tattoo inks) with the reason
 * and the Länder where the product was sold.
 * https://www.lebensmittelwarnung.de/___LMW-Redaktion/RSSNewsfeed/rssnewsfeed_node.html
 *
 * Each warning becomes a `recall` event over the outlines of the Länder it names (all 16 = all of
 * Germany). Recalls are never a push (rank.ts): they go to the feed and the daily summary.
 * The feed keeps warnings for months; only those published in the last 7 days become alerts,
 * and each stays in the feed for 14 days.
 */
export const LEBENSMITTELWARNUNG_URL = 'https://www.lebensmittelwarnung.de/___LMW-Redaktion/RSSNewsfeed/Functions/RssFeeds/rssnewsfeed_Alle_DE.xml?nn=314268';
const SOURCE_NAME = 'lebensmittelwarnung.de (Länder und BVL)';
export const MAX_AGE_DAYS = 7;
export const SHOWN_DAYS = 14;
/** Centre of Germany; the radius reaches every corner, the Länder outlines decide. */
const DE_CENTRE = { lat: 51.16, lon: 10.45, radiusM: 700_000 };

export interface Recall {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  product: string | null;
  reason: string | null;
  bestBefore: string | null;
  batch: string | null;
  maker: string | null;
  states: string[];
}

/** "<b>Grund der Meldung:</b> Krankheitserreger<br/>" → { "Grund der Meldung": "Krankheitserreger" } */
export function fields(description: string): Record<string, string> {
  const out: Record<string, string> = {};
  const html = description.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  for (const m of html.matchAll(/<b>\s*([^<:]+?)\s*:?\s*<\/b>([\s\S]*?)(?=<b>|$)/gi)) {
    const value = decode(stripHtml(m[2].replace(/<br\s*\/?>/gi, '\n'))).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    out[m[1].replace(/:$/, '').trim()] = value;
  }
  return out;
}

const oneLine = (s: string | undefined) => (s ? s.replace(/\s+/g, ' ').trim() || null : null);

export function parseRecalls(xml: string): Recall[] {
  const out: Recall[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const url = tag(b, 'link') || tag(b, 'guid');
    // ".../Meldungen/2026/11_November/261120_21_NI_Wildsalami/261120_21_NI_Wildsalami.html" → "261120_21_NI_Wildsalami"
    const id = url.match(/\/([^/]+)\.html$/)?.[1];
    if (!id) continue;
    const f = fields(tag(b, 'description', true));
    const statesText = f['Betroffene Bundesländer nach derzeitigem Stand'] ?? f['Betroffene Bundesländer'] ?? '';
    const states = Object.keys(DE_STATES).filter((s) => new RegExp(`(^|[,\\s])${s.replace('-', '\\-')}($|[,\\s])`).test(statesText));
    const date = tag(b, 'pubDate');
    out.push({
      id,
      title: decode(stripHtml(tag(b, 'title'))).replace(/\s+/g, ' ').trim(),
      url,
      publishedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date().toISOString(),
      product: oneLine(f['Produktbezeichnung/ -beschreibung'] ?? f['Produktbezeichnung']),
      reason: oneLine(f['Grund der Meldung']),
      bestBefore: oneLine(f['Haltbarkeit']),
      batch: oneLine(f['Chargennummer / Los-Kennzeichnung']),
      // First line that isn't a label ("Inverkehrbringer:"): the company, without its address.
      maker: oneLine((f['Hersteller / Inverkehrbringer'] ?? '').split('\n').map((l) => l.replace(/^(Hersteller|Inverkehrbringer)\s*:\s*/i, '').trim()).find(Boolean)),
      states,
    });
  }
  return out;
}

/** "Krankheitserreger" etc. are the portal's fixed reasons; in the body they read as "Grund: …". */
export function toSourceItem(r: Recall): SourceItem | null {
  if (!r.states.length) return null; // no Länder named: nowhere to show it
  const all = r.states.length === Object.keys(DE_STATES).length;
  const where = all ? 'ganz Deutschland' : r.states.join(', ');
  const name = r.title.length <= 40 ? r.title : (r.title.split(',')[0].slice(0, 40).trim());
  const body = [
    r.reason ? `Grund: ${r.reason}.` : null,
    `Verkauft in: ${where}.`,
    r.bestBefore ? `${r.bestBefore.replace(/\.$/, '')}.` : null,
    r.batch ? `Charge: ${clip(r.batch.replace(/^(Charge|Chargennummer|Losnummer)\s*:\s*/i, '').replace(/\.$/, ''), 140)}.` : null,
    r.maker ? `Hersteller/Händler: ${r.maker.replace(/[,.\s]+$/, '')}.` : null,
  ].filter(Boolean).join(' ');
  return {
    source: 'lebensmittelwarnung',
    sourceName: SOURCE_NAME,
    externalId: `lebensmittelwarnung:${r.id}`,
    official: true,
    structured: true,
    hazard: 'recall',
    category: 'recall',
    language: 'de',
    country: 'DE',
    title: `Rückruf: ${name}`,
    body,
    url: r.url,
    publishedAt: r.publishedAt,
    expiresAt: new Date(Date.parse(r.publishedAt) + SHOWN_DAYS * 86_400_000).toISOString(),
    ...DE_CENTRE,
    areaName: all ? 'Deutschland' : r.states.join(', '),
    areas: r.states.flatMap((s) => DE_STATES[s].rings),
    officialSeverity: 1,
  };
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** New warnings from the last 7 days. */
export async function fetchRecalls(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: (url: string) => Promise<string> = async (url) => {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/rss+xml, text/xml', 'User-Agent': 'HeyOkay/0.1 (safety alerts; contact via app)' } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.text();
  },
  opts: { now?: Date; url?: string } = {},
): Promise<SourceItem[]> {
  const now = (opts.now ?? new Date()).getTime();
  const xml = await get(opts.url ?? LEBENSMITTELWARNUNG_URL);
  if (!/<rss\b/i.test(xml)) throw new Error('lebensmittelwarnung.de: answer is not an RSS feed'); // a changed page must fail, not look like "no recalls"
  const out: SourceItem[] = [];
  for (const r of parseRecalls(xml)) {
    if (now - Date.parse(r.publishedAt) > MAX_AGE_DAYS * 86_400_000) continue;
    const item = toSourceItem(r);
    if (item && (await isNew(item.externalId))) out.push(item);
  }
  return out;
}

function tag(block: string, name: string, raw = false): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!m) return '';
  const v = m[1].trim();
  return raw ? v : v.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
