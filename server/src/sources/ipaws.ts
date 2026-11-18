import type { SourceItem } from '../types.js';
import { capAlertsIn, capItem, parseCap } from './cap.js';
import { fetchWithTimeout } from '../http.js';

/**
 * FEMA IPAWS — the US Integrated Public Alert & Warning System. Its public feed carries every
 * alert sent through IPAWS: Wireless Emergency Alerts, EAS and public-feed messages from state and
 * local authorities (evacuations, shelter-in-place, boil-water, AMBER, civil emergencies), plus the
 * National Weather Service. CAP 1.2, no key.
 * https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system/technology-developers/ipaws-all-hazards-information-feed
 *
 * NWS messages are skipped here: they come from the NWS adapter with zone outlines and early
 * all-clears. The endpoint returns alerts posted since a given time; the URL is checked on the
 * first live poll (the Alert Desk Sources table shows "failing" if it is wrong). IPAWS_URL overrides it.
 */
export const IPAWS_URL = 'https://apps.fema.gov/IPAWSOPEN_EAS_SERVICE/rest/public/recent/';
export const IPAWS_FEED_KEY = 'ipaws:US';

/** The National Weather Service sends through IPAWS too; we read it directly instead. */
export function isNws(sender: string, senderName: string): boolean {
  return /nws|noaa|weather\.gov|national weather service/i.test(`${sender} ${senderName}`);
}

export function ipawsItems(xml: string, now = new Date()): SourceItem[] {
  const out: SourceItem[] = [];
  for (const raw of capAlertsIn(xml)) {
    const alert = parseCap(raw);
    if (!alert) continue;
    const item = capItem(alert, {
      source: 'ipaws', sourceName: 'FEMA IPAWS', country: 'US', language: 'en', feedKey: IPAWS_FEED_KEY, now,
      skipSender: (a, info) => isNws(a.sender, info.senderName),
    });
    if (item) out.push(item);
  }
  return out;
}

export type TextGetter = (url: string) => Promise<string>;

export const textGetter: TextGetter = async (url) => {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/xml, text/xml' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
};

/** Alerts posted in the last `lookbackH` hours that we haven't seen yet. */
export async function fetchIpaws(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: TextGetter = textGetter,
  opts: { url?: string; now?: Date; lookbackH?: number } = {},
): Promise<SourceItem[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.lookbackH ?? 6) * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const xml = await get(`${opts.url ?? IPAWS_URL}${since}`);
  const out: SourceItem[] = [];
  for (const item of ipawsItems(xml, now)) if (await isNew(item.externalId)) out.push(item);
  return out;
}
