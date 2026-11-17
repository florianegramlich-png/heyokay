import { randomUUID } from 'node:crypto';
import type { EventStatus, ExtractedEvent, RiskEvent, SourceItem } from '../types.js';
import { distanceM } from '../geo.js';
import { ninaRootId } from '../sources/nina.js';

const WINDOW_MS = 6 * 3600_000;
const MIN_SIMILARITY = 0.25;

/**
 * Same event from several sources = one event, then updates.
 * MVP uses word overlap + distance + time; Phase 2 swaps in embeddings (pgvector) behind the same function.
 */
export function findCluster(ext: ExtractedEvent, item: SourceItem, active: RiskEvent[]): RiskEvent | null {
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
  if (item.source === 'nws') return null;
  let best: { e: RiskEvent; score: number } | null = null;
  for (const e of active) {
    if (e.category !== ext.category || ext.lat == null || ext.lon == null) continue;
    if (Math.abs(Date.parse(e.startsAt) - Date.parse(ext.startsAt)) > WINDOW_MS) continue;
    const d = distanceM(e.lat, e.lon, ext.lat, ext.lon);
    if (d > Math.min(e.radiusM, ext.radiusM) + 1000) continue;
    const sim = jaccard(tokens(`${e.title} ${e.summary}`), tokens(`${ext.title} ${ext.summary}`));
    const score = d < 300 ? Math.max(sim, MIN_SIMILARITY) : sim;
    if (score >= MIN_SIMILARITY && (!best || score > best.score)) best = { e, score };
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
    createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1,
  };
}

/**
 * Merge a new report into an existing event. Returns whether users should get an update
 * (severity went up). Official severity always wins over model severity.
 */
export function mergeInto(e: RiskEvent, ext: ExtractedEvent, item: SourceItem, now = new Date()): { escalated: boolean } {
  const before = e.severity;
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
  e.updatedAt = now.toISOString();
  const escalated = e.severity > before;
  if (escalated) {
    e.revision += 1;
    e.copyTitle = e.copyBody = e.copyAction = null; // re-write the alert for the new severity
  }
  return { escalated };
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
