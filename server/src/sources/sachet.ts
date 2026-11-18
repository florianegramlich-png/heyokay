import type { SourceItem } from '../types.js';
import { capAlertsIn, capItem, parseCap } from './cap.js';
import { textGetter, type TextGetter } from './ipaws.js';

/**
 * India: NDMA SACHET, the national Common Alerting Protocol platform of the National Disaster
 * Management Authority. IMD (weather), CWC (floods), INCOIS (tsunami, high waves) and the state
 * disaster authorities publish their alerts through it as CAP 1.2. https://sachet.ndma.gov.in
 *
 * The public RSS lists current alerts; each item links to its CAP file. Some items carry the CAP
 * alert inline — both are handled. English info blocks are preferred (many alerts also come in
 * Hindi or the state language). The URL is checked on the first live poll; SACHET_RSS_URL overrides it.
 */
export const SACHET_RSS_URL = 'https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml';
export const SACHET_FEED_KEY = 'sachet:IN';

export interface SachetEntry { link: string; guid: string; inlineCap: string | null }

export function parseSachetRss(xml: string): SachetEntry[] {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => {
    const b = m[0];
    const tag = (name: string) => (b.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&amp;/g, '&').trim();
    const inline = capAlertsIn(b)[0] ?? null;
    return { link: tag('link'), guid: tag('guid') || tag('link'), inlineCap: inline };
  }).filter((e) => e.link || e.inlineCap);
}

/**
 * Current SACHET alerts. Only alerts not seen before are fetched in full (`isNewEntry` on the RSS
 * guid saves one request per known alert); `listedIds` lets the pipeline end alerts that were
 * withdrawn early.
 */
export async function fetchSachet(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: TextGetter = textGetter,
  opts: { url?: string; now?: Date; maxFetches?: number } = {},
): Promise<{ feedKey: string; items: SourceItem[]; listedIds: Set<string> }> {
  const now = opts.now ?? new Date();
  const entries = parseSachetRss(await get(opts.url ?? SACHET_RSS_URL));
  const items: SourceItem[] = [];
  const listedIds = new Set<string>();
  let fetches = 0;
  for (const e of entries) {
    let capXml = e.inlineCap;
    if (!capXml) {
      // Known alerts: their CAP identifier is the guid's last path or query value; skip the download.
      const guessId = decodeURIComponent(e.guid.split(/[=/]/).pop() ?? '');
      if (guessId && !(await isNew(guessId))) { listedIds.add(guessId); continue; }
      if (fetches++ >= (opts.maxFetches ?? 40)) continue;
      capXml = await get(e.link);
    }
    const alert = parseCap(capXml);
    if (!alert) continue;
    const item = capItem(alert, { source: 'sachet', sourceName: 'NDMA SACHET', country: 'IN', language: 'en', feedKey: SACHET_FEED_KEY, now });
    if (!item) continue;
    listedIds.add(item.externalId);
    if (await isNew(item.externalId)) items.push(item);
  }
  return { feedKey: SACHET_FEED_KEY, items, listedIds };
}
