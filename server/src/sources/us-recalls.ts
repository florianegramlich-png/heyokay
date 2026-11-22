import type { SourceItem } from '../types.js';
import { fetchWithTimeout } from '../http.js';
import { US_STATES } from '../data/us-states.js';
import { COUNTRY_AREAS } from './statuspage.js';

/**
 * Product and food recalls in the US, from two federal agencies (public APIs, no key, US
 * government works, no copyright):
 *
 * - FDA enforcement reports (openFDA, https://open.fda.gov/apis/food/enforcement/ and
 *   /apis/drug/enforcement/): food and drug recalls, published weekly. Each record is one recalled
 *   product; records of one recall share an `event_id` and become one alert. `distribution_pattern`
 *   is free text ("CT, MA, NY", "Nationwide", "Arizona, Colorado …"): the states it names decide
 *   where the alert shows. Food: class I and II (class III means "unlikely to cause harm"). Drugs:
 *   class I, and class II only for over-the-counter medicines; most class II drug recalls are
 *   prescription, injectable or compounding-pharmacy lots that people don't buy at a shop.
 * - CPSC recalls (https://www.saferproducts.gov/RestWebServices, https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information):
 *   consumer products (toys, furniture, batteries …), sold nationwide.
 *
 * Same `recall` topic as lebensmittelwarnung.de: feed only, never a push (rank.ts).
 * USDA FSIS (meat, poultry, egg products) has an API too, but it answers 403 to servers
 * (see CHANGELOG), so meat and poultry recalls are not covered yet.
 */
export const OPENFDA_URL = 'https://api.fda.gov';
export const CPSC_URL = 'https://www.saferproducts.gov/RestWebServices/Recall';
/** FDA reports weekly, a week or two after the recall starts: look back 14 days of reports. */
export const FDA_MAX_AGE_DAYS = 14;
/** CPSC publishes on the day of the recall. */
export const CPSC_MAX_AGE_DAYS = 7;
export const SHOWN_DAYS = 14;
const US = COUNTRY_AREAS.US!;
/** Nationwide = every state's outline (finer than the coarse country outline the status pages use). */
const ALL_STATES = Object.values(US_STATES).flatMap((s) => s.rings);
const UA = 'HeyOkay/0.1 (safety alerts; contact via app)';

export type FdaKind = 'food' | 'drug';

export interface FdaRecord {
  event_id?: string;
  recall_number?: string;
  status?: string;
  classification?: string;
  product_type?: string;
  recalling_firm?: string;
  distribution_pattern?: string;
  product_description?: string;
  reason_for_recall?: string;
  code_info?: string;
  report_date?: string;
}

export interface FdaRecall {
  id: string;
  kind: FdaKind;
  classification: string;
  firm: string;
  product: string;
  products: number;
  reason: string | null;
  codes: string | null;
  reportDate: string;
  nationwide: boolean;
  states: string[];
}

const NAME_TO_CODE = Object.fromEntries(Object.entries(US_STATES).map(([code, s]) => [s.name.toLowerCase(), code]));
// Longest first, so "West Virginia" is read before "Virginia" and "Arkansas" before "Kansas".
const NAMES = Object.keys(NAME_TO_CODE).sort((a, b) => b.length - a.length);

/**
 * "Distributed in CT, FL, GA and WI." → states; "Nationwide", "across the country", sold online → whole US.
 * A pattern that names no state and isn't nationwide (e.g. "sold to 16 customers") gives nothing.
 */
export function distribution(text: string | undefined): { nationwide: boolean; states: string[] } {
  // "Washington, D.C." is DC, not the state of Washington.
  const t = (text ?? '').replace(/\s+/g, ' ').replace(/\bWashington,? D\.? ?C\.?(?![A-Za-z])/gi, 'DC');
  if (/\bnation\s?wide\b|\bacross the (country|u\.?s\.?|united states)\b|\bthroughout the (country|u\.?s\.?|united states)\b|\ball (50 )?states\b|\b(u\.?s\.?|usa) wide\b/i.test(t)) return { nationwide: true, states: [] };
  const found = new Set<string>();
  let rest = t.toLowerCase();
  for (const name of NAMES) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    if (re.test(rest)) { found.add(NAME_TO_CODE[name]); rest = rest.replace(re, ' '); }
  }
  // Two-letter codes only in capitals and on their own ("MA, CT", "TX only"), never inside words.
  for (const m of t.matchAll(/(?<![A-Za-z.])([A-Z]{2})(?![A-Za-z])/g)) if (US_STATES[m[1]]) found.add(m[1]);
  if (found.size === Object.keys(US_STATES).length) return { nationwide: true, states: [] };
  if (!found.size && /\b(online|website|internet|amazon(\.com)?|e-?commerce)\b/i.test(t)) return { nationwide: true, states: [] };
  return { nationwide: false, states: [...found].sort() };
}

/** "Raw milk cheddar cheese packed in vacuum sealed clear plastic …" → "Raw milk cheddar cheese". */
export function productName(description: string | undefined): string {
  let s = (description ?? '').replace(/\s+/g, ' ').trim();
  s = s.split(/[,;:(•]| - | – |\. |\bUPC\b|\bNDC\b|\bLot\b|\b(packed|packaged|sold|distributed|labeled|labelled|contained|marketed) (in|as|under|by)\b|\bin (a|an|clear|plastic|glass|individual)\b/i)[0].trim();
  s = s.replace(/^["'“]+|["'”.]+$/g, '').trim();
  if (s.length > 40) s = `${s.slice(0, 40).replace(/\s+\S*$/, '')}…`;
  return s;
}

const firmName = (firm: string | undefined) =>
  (firm ?? '').replace(/\s+/g, ' ').replace(/[,\s]+(llc|l\.l\.c\.|inc\.?|incorporated|corp\.?|corporation|co\.|ltd\.?|lp|l\.p\.)\.?$/i, '').replace(/[,.\s]+$/, '').trim();

/** Prescription-only, injectables and compounding vials: for pharmacies and hospitals, not the shop shelf. */
const NOT_OVER_THE_COUNTER = /\bRx\b|\binject(ion|able)s?\b|\bintravenous\b|\bvials?\b|\(MDV\)|\bfor (hospital|professional) use\b/i;

function keep(kind: FdaKind, r: FdaRecord): boolean {
  if (/terminated/i.test(r.status ?? '')) return false;
  const c = r.classification ?? '';
  if (kind === 'food') return /^class i{1,2}$/i.test(c);
  // Drugs: class I always; class II only for medicines people buy themselves (eye drops, pain relief).
  return /^class i$/i.test(c) || (/^class ii$/i.test(c) && !NOT_OVER_THE_COUNTER.test(r.product_description ?? ''));
}

/** One recall per FDA event, from the records of one weekly report window. */
export function parseFda(json: unknown, kind: FdaKind, since = '00000000'): FdaRecall[] {
  const results = (json as { results?: FdaRecord[] })?.results;
  if (!Array.isArray(results)) return [];
  const byEvent = new Map<string, FdaRecord[]>();
  for (const r of results) {
    if (!r.event_id || !r.report_date || r.report_date < since || !keep(kind, r)) continue;
    byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);
  }
  const out: FdaRecall[] = [];
  for (const [id, recs] of byEvent) {
    const first = recs[0];
    const states = new Set<string>();
    let nationwide = false;
    for (const r of recs) {
      const d = distribution(r.distribution_pattern);
      nationwide ||= d.nationwide;
      d.states.forEach((s) => states.add(s));
    }
    out.push({
      id,
      kind,
      // The most serious class of the event's products.
      classification: recs.some((r) => /^class i$/i.test(r.classification ?? '')) ? 'Class I' : 'Class II',
      firm: firmName(first.recalling_firm),
      product: productName(first.product_description),
      products: new Set(recs.map((r) => r.product_description)).size,
      reason: oneLine(first.reason_for_recall),
      codes: recs.length === 1 ? oneLine(first.code_info) : null,
      reportDate: recs.map((r) => r.report_date!).sort()[0],
      nationwide,
      states: nationwide ? [] : [...states].sort(),
    });
  }
  return out;
}

const oneLine = (s: string | undefined | null) => (s ? s.replace(/\s+/g, ' ').trim() || null : null);
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** "20261111" → "2026-11-11T12:00:00.000Z" (midday, so the US date stays the same in every US time zone). */
const fdaDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00.000Z`;

function where(nationwide: boolean, states: string[]): { text: string; areaName: string; areas: [number, number][][] } {
  if (nationwide) return { text: 'nationwide', areaName: US.name, areas: ALL_STATES };
  const names = states.map((s) => US_STATES[s].name);
  return {
    text: states.length <= 8 ? states.join(', ') : `${states.length} states`,
    areaName: states.length <= 3 ? names.join(', ') : `${states.length} US states`,
    areas: states.flatMap((s) => US_STATES[s].rings),
  };
}

export function fdaToSourceItem(r: FdaRecall): SourceItem | null {
  if (!r.nationwide && !r.states.length) return null; // nowhere to show it
  const w = where(r.nationwide, r.states);
  const publishedAt = fdaDate(r.reportDate);
  const body = [
    r.reason ? `Reason: ${clip(r.reason.replace(/\.$/, ''), 160)}.` : null,
    `Sold in: ${w.text}.`,
    r.products > 1 ? `${r.products} products.` : null,
    r.codes ? `${clip(r.codes.replace(/\.$/, ''), 100)}.` : null,
    r.firm ? `Company: ${r.firm}.` : null,
  ].filter(Boolean).join(' ');
  return {
    source: 'fda',
    sourceName: r.kind === 'food' ? 'FDA · Food recalls' : 'FDA · Drug recalls',
    externalId: `fda:${r.kind}:${r.id}`,
    official: true,
    structured: true,
    hazard: 'recall',
    category: 'recall',
    language: 'en',
    country: 'US',
    title: `Recall: ${r.product || r.firm}`,
    body,
    // The weekly enforcement report; openFDA has no page per recall.
    url: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm',
    publishedAt,
    expiresAt: new Date(Date.parse(publishedAt) + SHOWN_DAYS * 86_400_000).toISOString(),
    lat: US.lat, lon: US.lon, radiusM: US.radiusM,
    areaName: w.areaName,
    areas: w.areas,
    officialSeverity: 1,
  };
}

export interface CpscRecall {
  RecallNumber?: string;
  RecallDate?: string;
  Title?: string;
  URL?: string;
  Products?: { Name?: string; NumberOfUnits?: string }[];
  RemedyOptions?: { Option?: string }[];
  Manufacturers?: { Name?: string }[];
}

/**
 * "Kidsview Recalls Infant Bouncers Due to Risk of Collapse and Impact Injury to Infants"
 * → "collapse and impact injury to infants". The calm version: no "serious injury or death".
 */
export function cpscReason(title: string | undefined): string | null {
  const m = (title ?? '').match(/\bDue to (.+?)(;|$)/i);
  if (!m) return null;
  const s = m[1].trim()
    .replace(/^(a |the )?(serious )?risks? of (serious )?(injury|injuries)( (and|or) death)? (from|due to|by) /i, '')
    .replace(/^(a |the )?(serious )?risks? of (serious )?(injury|injuries) (and|or) death$/i, 'injury')
    .replace(/^(a |the )?risks? of /i, '')
    .replace(/\s+/g, ' ');
  // CPSC titles are in title case: "Fire and Burn Hazards" → "fire and burn hazards" (acronyms stay).
  const lower = s.replace(/\b([A-Z])([a-z]+)\b/g, (_, a: string, rest: string) => a.toLowerCase() + rest);
  return lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : null;
}

export function cpscToSourceItem(r: CpscRecall): SourceItem | null {
  if (!r.RecallNumber || !r.RecallDate || Number.isNaN(Date.parse(r.RecallDate))) return null;
  const name = oneLine(r.Products?.[0]?.Name) ?? oneLine(r.Title?.replace(/\bRecalls?\b.*$/i, '')) ?? 'Product';
  const reason = cpscReason(r.Title);
  const remedy = [...new Set((r.RemedyOptions ?? []).map((o) => o.Option?.trim().toLowerCase()).filter(Boolean))].join(' or ');
  const units = oneLine(r.Products?.[0]?.NumberOfUnits?.replace(/\(.*?\)/g, ''));
  const publishedAt = new Date(`${r.RecallDate.slice(0, 10)}T12:00:00.000Z`).toISOString();
  const body = [
    reason ? `Reason: ${clip(reason, 120)}.` : null,
    'Sold in: nationwide.',
    remedy ? `Remedy: ${remedy}.` : null,
    units ? `Units: ${units.replace(/^about /i, 'about ')}.` : null,
  ].filter(Boolean).join(' ');
  return {
    source: 'cpsc',
    sourceName: 'CPSC · Product recalls',
    externalId: `cpsc:${r.RecallNumber}`,
    official: true,
    structured: true,
    hazard: 'recall',
    category: 'recall',
    language: 'en',
    country: 'US',
    title: `Recall: ${name.length <= 40 ? name : `${name.slice(0, 40).replace(/\s+\S*$/, '')}…`}`,
    body,
    url: r.URL || 'https://www.cpsc.gov/Recalls',
    publishedAt,
    expiresAt: new Date(Date.parse(publishedAt) + SHOWN_DAYS * 86_400_000).toISOString(),
    lat: US.lat, lon: US.lon, radiusM: US.radiusM,
    areaName: US.name,
    areas: ALL_STATES,
    officialSeverity: 1,
  };
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

type Get = (url: string) => Promise<{ status: number; text: string }>;
const defaultGet: Get = async (url) => {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  return { status: res.status, text: await res.text() };
};

/** New FDA food (class I/II) and drug (class I) recalls from the last 14 days of reports. */
export async function fetchFdaRecalls(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: Get = defaultGet,
  opts: { now?: Date; url?: string } = {},
): Promise<SourceItem[]> {
  const now = (opts.now ?? new Date()).getTime();
  const since = ymd(now - FDA_MAX_AGE_DAYS * 86_400_000);
  const range = `[${since}+TO+${ymd(now)}]`;
  const out: SourceItem[] = [];
  for (const kind of ['food', 'drug'] as const) {
    const url = `${opts.url ?? OPENFDA_URL}/${kind}/enforcement.json?search=report_date:${range}&limit=1000`;
    const res = await get(url);
    // openFDA answers 404 NOT_FOUND when a window has no records: that is "no recalls", not a failure.
    if (res.status === 404 && /NOT_FOUND/.test(res.text)) continue;
    if (res.status !== 200) throw new Error(`${url} → HTTP ${res.status}`);
    let json: unknown;
    try { json = JSON.parse(res.text); } catch { throw new Error('openFDA: answer is not JSON'); }
    if (!Array.isArray((json as { results?: unknown }).results)) throw new Error('openFDA: answer has no results'); // a changed API must fail, not look like "no recalls"
    for (const r of parseFda(json, kind, since)) {
      const item = fdaToSourceItem(r);
      if (item && (await isNew(item.externalId))) out.push(item);
    }
  }
  return out;
}

/** New CPSC recalls from the last 7 days. */
export async function fetchCpscRecalls(
  isNew: (externalId: string) => boolean | Promise<boolean>,
  get: Get = defaultGet,
  opts: { now?: Date; url?: string } = {},
): Promise<SourceItem[]> {
  const now = (opts.now ?? new Date()).getTime();
  const since = new Date(now - CPSC_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const url = `${opts.url ?? CPSC_URL}?format=json&RecallDateStart=${since}`;
  const res = await get(url);
  if (res.status !== 200) throw new Error(`${url} → HTTP ${res.status}`);
  let json: unknown;
  try { json = JSON.parse(res.text); } catch { throw new Error('CPSC: answer is not JSON'); }
  if (!Array.isArray(json)) throw new Error('CPSC: answer is not a list of recalls');
  const out: SourceItem[] = [];
  for (const r of json as CpscRecall[]) {
    if (!r.RecallDate || now - Date.parse(r.RecallDate) > CPSC_MAX_AGE_DAYS * 86_400_000 + 86_400_000) continue;
    const item = cpscToSourceItem(r);
    if (item && (await isNew(item.externalId))) out.push(item);
  }
  return out;
}
