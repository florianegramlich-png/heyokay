import { z } from 'zod';
import type { Category, ExtractedEvent, Severity, SourceItem } from '../types.js';
import { CATEGORIES } from '../types.js';
import type { StructuredLLM } from '../llm.js';
import type { Geocoder } from '../geocode.js';
import { findInText } from '../geocode.js';

/** Items older than this are history, not alerts. */
const MAX_AGE_H = 12;

const ExtractionSchema = z.object({
  isCurrentSafetyEvent: z.boolean().describe('True only if this describes a current or imminent risk to people in a specific place. False for appeals about past incidents, court reports, statistics, recruitment, events that ended.'),
  category: z.enum(CATEGORIES),
  severity: z.number().int().min(1).max(5).describe('1 info, 2 minor, 3 moderate, 4 severe, 5 extreme danger to life'),
  confidence: z.number().min(0).max(1),
  title: z.string().describe('Neutral German headline using only facts from the text'),
  summary: z.string().describe('One or two German sentences using only facts from the text'),
  place: z.string().describe('Most specific place named in the text: street + district + city if available. Empty if none.'),
  radiusM: z.number().int().min(100).max(50000).describe('Affected radius in metres'),
  endsAt: z.string().nullable().describe('ISO time the risk ends, only if the text states it'),
});

const SYSTEM = `You extract structured safety events from German public sources (police press releases, transit notices, municipal bulletins).
Rules:
- Use ONLY facts stated in the text. Never add numbers, times, places or causes that are not in the text.
- Report events, not areas: never describe a neighbourhood as dangerous.
- Do not include personal data about suspects or victims (names, ages, nationality, appearance).
- Severity: 1 info, 2 minor disruption, 3 moderate risk/disruption, 4 serious danger (e.g. large fire, armed police operation, major line closure), 5 danger to life for many people.
- If the text is about a past incident with no ongoing risk, set isCurrentSafetyEvent=false.`;

export interface ExtractDeps {
  llm: StructuredLLM;
  geocoder: Geocoder;
  now?: Date;
  defaultArea?: { name: string; lat: number; lon: number; radiusM: number };
}

/** Returns null when the item is not a current, locatable safety event. */
export async function extract(item: SourceItem, deps: ExtractDeps): Promise<ExtractedEvent | null> {
  const now = deps.now ?? new Date();
  if (!item.official && now.getTime() - Date.parse(item.publishedAt) > MAX_AGE_H * 3600_000) return null;

  // Official feeds are already structured. Their severity is authoritative.
  if (item.official && item.lat != null && item.lon != null) {
    return {
      category: item.category ?? 'public_safety',
      severity: item.officialSeverity ?? 2,
      confidence: 1,
      title: item.title,
      summary: firstSentences(item.body, 2),
      areaName: item.areaName ?? '',
      lat: item.lat, lon: item.lon, radiusM: item.radiusM ?? 2000,
      startsAt: item.publishedAt,
      endsAt: item.expiresAt ?? null,
    };
  }

  const text = `${item.title}\n\n${item.body}`.slice(0, 6000);
  const llmOut = await deps.llm.generate(SYSTEM, `Source: ${item.sourceName}\nPublished: ${item.publishedAt}\n\n${text}`, ExtractionSchema);

  if (llmOut) {
    if (!llmOut.isCurrentSafetyEvent) return null;
    const geo = (llmOut.place && (await deps.geocoder.geocode(llmOut.place))) || findInText(text) || deps.defaultArea || null;
    if (!geo) return null;
    const placeFromText = !!llmOut.place && text.toLowerCase().includes(llmOut.place.split(',')[0].trim().toLowerCase());
    return {
      category: (item.category && llmOut.category === 'public_safety' ? item.category : llmOut.category) as Category,
      severity: llmOut.severity as Severity,
      // A place the model could not point to in the text lowers confidence → Alert Desk.
      confidence: placeFromText ? llmOut.confidence : Math.min(llmOut.confidence, 0.5),
      title: llmOut.title,
      summary: llmOut.summary,
      areaName: llmOut.place || geo.name,
      lat: geo.lat, lon: geo.lon,
      radiusM: Math.max(llmOut.radiusM, Math.min(geo.radiusM, 5000)),
      startsAt: item.publishedAt,
      endsAt: llmOut.endsAt && !Number.isNaN(Date.parse(llmOut.endsAt)) ? new Date(llmOut.endsAt).toISOString() : null,
    };
  }

  // No LLM: keyword rules. Low confidence on purpose, so a human reviews before anyone is alerted.
  return heuristicExtract(item, text, deps.defaultArea ?? null);
}

const KEYWORDS: Array<[Category, RegExp]> = [
  ['transit', /\b(s-?bahn|u-?bahn|tram|bus(linie)?|zugausfall|stellwerk|signalstörung|gleis|ersatzverkehr|sperrung der linie|bahnhof)\b/i],
  ['weather', /\b(unwetter|sturm|orkan|gewitter|hagel|starkregen|hitze|glätte|glatteis|hochwasser|überschwemmung)\b/i],
  ['health', /\b(trinkwasser|abkochgebot|infektion|ausbruch|gesundheitsamt|legionellen)\b/i],
  ['infrastructure', /\b(stromausfall|gasleck|gasaustritt|wasserrohrbruch|brücke gesperrt|fernwärme)\b/i],
  ['crime', /\b(polizeieinsatz|festnahme|raub|überfall|messer|schuss|schüsse|bewaffnet|einbruch|fahndung|bedrohung)\b/i],
  ['public_safety', /\b(brand|feuer|rauch|evakuier|bombe|blindgänger|explosion|großeinsatz|feuerwehr|sperrung)\b/i],
];
const HIGH = /\b(evakuier|blindgänger|bombe|explosion|schüsse|großbrand|lebensgefahr|großeinsatz|amok)\w*/i;
const MID = /\b(brand|sperrung|ausfall|gesperrt|polizeieinsatz|bewaffnet|unwetter|stromausfall)\w*/i;
const PAST = /\b(zeugen gesucht|zeugenaufruf|bereits am|vergangene[nm]? (woche|monat)|verurteilt|prozess)\b/i;

export function heuristicExtract(item: SourceItem, text: string, defaultArea: ExtractDeps['defaultArea'] | null): ExtractedEvent | null {
  if (PAST.test(text)) return null;
  const category = item.category ?? KEYWORDS.find(([, re]) => re.test(text))?.[0];
  if (!category) return null;
  const geo = findInText(text) ?? defaultArea;
  if (!geo) return null;
  const severity: Severity = HIGH.test(text) ? 4 : MID.test(text) ? 3 : 2;
  return {
    category, severity, confidence: 0.4,
    title: item.title.slice(0, 120),
    summary: firstSentences(item.body, 2),
    areaName: geo.name, lat: geo.lat, lon: geo.lon, radiusM: Math.min(geo.radiusM, 3000),
    startsAt: item.publishedAt, endsAt: null,
  };
}

export function firstSentences(s: string, n: number): string {
  const parts = s.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  return parts.slice(0, n).join(' ').slice(0, 400);
}
