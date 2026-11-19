import { packFor } from '../countries.js';
import { randomUUID } from 'node:crypto';
import type { EventStatus, ExtractedEvent, RiskEvent, SourceItem } from '../types.js';
import { distanceM } from '../geo.js';
import { ninaRootId } from '../sources/nina.js';

const WINDOW_MS = 6 * 3600_000;
const MIN_SIMILARITY = 0.25;
export const DEFAULT_EMBEDDING_MIN_SIMILARITY = 0.8;

export interface EmbeddingMatch {
  /** Cosine similarity of the new report to each active event that has an embedding from the same model. */
  similarity: Map<string, number>;
  /** At or above this, two reports that pass the geo and time checks are the same incident. */
  minSimilarity: number;
}

/**
 * Same event from several sources = one event, then updates.
 * Hard rules first (NINA id root, CAP references, NWS never fuzzy). Then candidates must share the
 * category, start within 6 h and lie close together; among those, embedding similarity decides when
 * both sides have a vector, otherwise word overlap (the fallback when no provider is set or it fails).
 */
export function findCluster(ext: ExtractedEvent, item: SourceItem, active: RiskEvent[], emb?: EmbeddingMatch): RiskEvent | null {
  if (item.source === 'nina') {
    const root = ninaRootId(item.externalId);
    const same = active.find((e) => e.sources.some((s) => ninaRootId(s.externalId) === root));
    if (same) return same;
  }
  // CAP updates/cancellations name the message they replace (NWS does this for every update).
  if (item.references?.length) {
    const refs = new Set(item.references);
    const same = active.find((e) => e.sources.some((s) => refs.has(s.externalId)));
    if (same) return same;
  }
  // NWS gives every alert an id and names the alert it updates. Two different NWS alerts are two
  // different warnings even when their wording is alike ("... until November 18 at ..."), so never fuzzy-merge.
  // Same for status-page incidents: each has its own id, and every outage sits on the same
  // country-wide area, so the distance rule would merge them all. Gauges: one event per gauge, by id.
  if (item.source === 'nws' || item.source === 'statuspage' || item.source === 'ipaws' || item.source === 'sachet' || item.source === 'usgs' || item.source === 'pegelonline') return null;
  let best: { e: RiskEvent; score: number } | null = null;
  for (const e of active) {
    if (e.category !== ext.category || ext.lat == null || ext.lon == null) continue;
    if (Math.abs(Date.parse(e.startsAt) - Date.parse(ext.startsAt)) > WINDOW_MS) continue;
    const d = distanceM(e.lat, e.lon, ext.lat, ext.lon);
    if (d > Math.min(e.radiusM, ext.radiusM) + 1000) continue;
    const vec = emb?.similarity.get(e.id);
    // Put both measures on one scale (1 = the threshold) so the best candidate wins either way.
    const sim = vec != null
      ? vec / emb!.minSimilarity
      : jaccard(tokens(`${e.title} ${e.summary}`), tokens(`${ext.title} ${ext.summary}`)) / MIN_SIMILARITY;
    const score = d < 300 ? Math.max(sim, 1) : sim;
    if (score >= 1 && (!best || score > best.score)) best = { e, score };
  }
  return best?.e ?? null;
}

export function newEvent(ext: ExtractedEvent, item: SourceItem, status: EventStatus, now = new Date()): RiskEvent {
  return {
    id: randomUUID(),
    category: ext.category, severity: ext.severity, confidence: ext.confidence, official: item.official,
    title: ext.title, summary: ext.summary, areaName: ext.areaName,
    lat: ext.lat!, lon: ext.lon!, radiusM: ext.radiusM,
    ...(item.areas?.length ? { areas: item.areas } : {}),
    startsAt: ext.startsAt, endsAt: ext.endsAt, status,
    facts: factText(item),
    sources: [{ sourceName: item.sourceName, externalId: item.externalId, url: item.url, title: item.title, official: item.official }],
    copyTitle: null, copyBody: null, copyAction: null, copyIsTemplate: false,
    language: item.language ?? 'de',
    ...(item.hazard ? { hazard: item.hazard } : {}),
    ...(item.onsetAt ? { onsetAt: item.onsetAt } : {}),
    country: packFor(item).code,
    ...(item.feedKey ? { feedKeys: [item.feedKey] } : {}),
    createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1,
  };
}

/** End-time shifts smaller than this aren't worth telling anyone about. */
const END_SHIFT_MS = 60 * 60_000;

/**
 * Merge a new report into an existing event. Official severity always wins over model severity.
 * - escalated: severity went up → everyone affected gets a fresh alert (and may get a push).
 * - changed: it went down or its official end time moved by an hour or more → people who already
 *   got it get a calm update in their feed.
 */
export function mergeInto(e: RiskEvent, ext: ExtractedEvent, item: SourceItem, now = new Date()): { escalated: boolean; changed: boolean } {
  const before = e.severity;
  // The newest report says when it starts; a warning now in effect has no future onset.
  if (item.onsetAt) e.onsetAt = item.onsetAt; else delete e.onsetAt;
  const endBefore = e.endsAt;
  if (item.official) {
    e.severity = ext.severity;
    e.official = true;
    e.confidence = 1;
    if (e.status === 'pending_review') e.status = 'auto';
    e.endsAt = ext.endsAt;
    e.title = ext.title;
    e.summary = ext.summary;
    if (item.areas?.length) {
      // The official area changed (e.g. an NWS update dropped zones): follow it.
      e.areas = item.areas;
      if (ext.lat != null && ext.lon != null) { e.lat = ext.lat; e.lon = ext.lon; e.radiusM = ext.radiusM; }
    }
  } else if (!e.official) {
    e.severity = Math.max(e.severity, ext.severity) as RiskEvent['severity'];
    e.confidence = Math.max(e.confidence, ext.confidence);
    if (ext.endsAt) e.endsAt = ext.endsAt;
  }
  if (!e.sources.some((s) => s.externalId === item.externalId)) {
    e.sources.push({ sourceName: item.sourceName, externalId: item.externalId, url: item.url, title: item.title, official: item.official });
    e.facts = `${e.facts}\n---\n${factText(item)}`.slice(-20_000);
  }
  if (item.feedKey && !(e.feedKeys ?? []).includes(item.feedKey)) e.feedKeys = [...(e.feedKeys ?? []), item.feedKey];
  e.updatedAt = now.toISOString();
  const escalated = e.severity > before;
  const endShifted = endBefore !== e.endsAt && (
    !endBefore || !e.endsAt || Math.abs(Date.parse(e.endsAt) - Date.parse(endBefore)) >= END_SHIFT_MS);
  const changed = !escalated && (e.severity < before || (item.official && endShifted));
  if (escalated || changed) {
    e.revision += 1;
    e.copyTitle = e.copyBody = e.copyAction = null; // re-write the alert for what changed
  }
  return { escalated, changed };
}

function factText(item: SourceItem): string {
  return [item.title, item.body, item.areaName].filter(Boolean).join('\n');
}

const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'mit', 'von', 'für', 'auf', 'aus', 'bei', 'nach', 'wegen', 'einer', 'eines', 'einem', 'sind', 'wird', 'wurde', 'werden', 'haben', 'heute']);
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4 && !STOP.has(t)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
