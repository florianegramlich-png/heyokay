import type { SourceItem, SourceKind } from '../types.js';
import type { CountryCode } from '../countries.js';
import { enclosingCircle, polygonCircle, thinRing, type Ring } from '../geo.js';
import { mapCategory, mapSeverity } from './nina.js';

/**
 * CAP 1.2 (Common Alerting Protocol, OASIS) — the standard every official alert feed in our
 * launch markets speaks: DWD and NINA (Germany), FEMA IPAWS and NWS (US), NDMA SACHET (India).
 * http://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.html
 *
 * One parser, one mapping to SourceItem; each feed adapter only knows where its alerts come from.
 * Areas: <polygon> ("lat,lon lat,lon …") and <circle> ("lat,lon radiusKm"). Alerts with neither
 * can't be matched to people and are skipped.
 */
export interface CapInfo {
  language: string;
  categories: string[];
  event: string;
  urgency: string;
  severity: string;
  certainty: string;
  senderName: string;
  headline: string;
  description: string;
  instruction: string;
  web: string;
  effective: string;
  onset: string;
  expires: string;
  areas: Array<{ desc: string; rings: Ring[] }>;
}

export interface CapAlert {
  identifier: string;
  sender: string;
  sent: string;
  status: string;
  msgType: string;
  scope: string;
  references: string[];
  infos: CapInfo[];
}

export function parseCap(xml: string): CapAlert | null {
  const identifier = text(xml, 'identifier');
  if (!identifier) return null;
  const infos = blocks(xml, 'info').map((info): CapInfo => ({
    language: text(info, 'language') || 'en-US',
    categories: all(info, 'category').map(decode),
    event: text(info, 'event'),
    urgency: text(info, 'urgency'),
    severity: text(info, 'severity'),
    certainty: text(info, 'certainty'),
    senderName: text(info, 'senderName'),
    headline: text(info, 'headline'),
    description: text(info, 'description'),
    instruction: text(info, 'instruction'),
    web: text(info, 'web'),
    effective: text(info, 'effective'),
    onset: text(info, 'onset'),
    expires: text(info, 'expires'),
    areas: blocks(info, 'area').map((a) => ({
      desc: text(a, 'areaDesc'),
      rings: [...all(a, 'polygon').map(polygonRing), ...all(a, 'circle').map(circleRing)].filter((r): r is Ring => !!r),
    })),
  }));
  return {
    identifier,
    sender: text(xml, 'sender'),
    sent: text(xml, 'sent'),
    status: text(xml, 'status'),
    msgType: text(xml, 'msgType'),
    scope: text(xml, 'scope'),
    // "sender,identifier,sent sender,identifier,sent …"
    references: (text(xml, 'references') || '').split(/\s+/).map((r) => r.split(',')[1]).filter(Boolean),
    infos,
  };
}

/** "lat,lon lat,lon …" → [lon, lat] ring. */
function polygonRing(s: string): Ring | null {
  const ring = s.trim().split(/\s+/).map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)).map(([lat, lon]) => [lon, lat] as [number, number]);
  return ring.length >= 3 ? ring : null;
}

/** "lat,lon radiusKm" → a 24-point ring approximating the circle. */
function circleRing(s: string): Ring | null {
  const m = s.trim().match(/^(-?[\d.]+),(-?[\d.]+)\s+([\d.]+)$/);
  if (!m) return null;
  const [lat, lon, km] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!(km > 0)) return null;
  const ring: Ring = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    const dLat = (km / 111.32) * Math.cos(a);
    const dLon = (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a);
    ring.push([lon + dLon, lat + dLat]);
  }
  return ring;
}

export interface CapItemOptions {
  source: SourceKind;
  /** Fallback name when the info block has no senderName. */
  sourceName: string;
  country: CountryCode;
  /** Info block to prefer by language prefix, e.g. 'en'. */
  language: 'de' | 'en';
  feedKey?: string;
  /** Skip alerts from these senders (e.g. NWS inside IPAWS — NWS has its own adapter). */
  skipSender?: (alert: CapAlert, info: CapInfo) => boolean;
  now?: Date;
}

/** CAP alert → SourceItem. Null for tests, exercises, non-public scope, skipped senders or alerts without an area. */
export function capItem(alert: CapAlert, o: CapItemOptions): SourceItem | null {
  if (alert.status !== 'Actual') return null;
  if (alert.scope && alert.scope !== 'Public') return null;
  const info = alert.infos.find((i) => i.language.toLowerCase().startsWith(o.language)) ?? alert.infos[0];
  if (!info) return null;
  if (o.skipSender?.(alert, info)) return null;
  const rings = info.areas.flatMap((a) => a.rings);
  if (!rings.length) return null;
  const circle = enclosingCircle(rings.map((r) => polygonCircle(r)));
  const names = info.areas.map((a) => a.desc).filter(Boolean);
  const more = o.language === 'de' ? 'weitere' : 'more';
  const cancelled = alert.msgType === 'Cancel';
  const now = o.now ?? new Date();
  return {
    source: o.source,
    sourceName: info.senderName || o.sourceName,
    externalId: alert.identifier,
    references: alert.references,
    official: true,
    language: o.language,
    country: o.country,
    title: info.headline || info.event,
    body: [info.description, info.instruction].filter(Boolean).join('\n\n').trim(),
    url: info.web || undefined,
    publishedAt: iso(alert.sent) ?? now.toISOString(),
    lat: circle.lat, lon: circle.lon, radiusM: Math.round(circle.radiusM),
    areas: rings.map((r) => thinRing(r)),
    officialSeverity: mapSeverity(info.severity),
    category: mapCategory('', info.categories),
    expiresAt: cancelled ? now.toISOString() : (iso(info.expires) ?? undefined),
    areaName: names.length > 3 ? `${names.slice(0, 3).join(', ')} + ${names.length - 3} ${more}` : names.join(', ') || undefined,
    ...(o.feedKey ? { feedKey: o.feedKey } : {}),
  };
}

/** Every <alert> in a document (a feed may wrap many). */
export function capAlertsIn(xml: string): string[] {
  return [...xml.matchAll(/<(?:\w+:)?alert\b[^>]*>[\s\S]*?<\/(?:\w+:)?alert>/g)].map((m) => m[0]);
}

function iso(s: string): string | null {
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'g'))].map((m) => m[1]);
}
const all = blocks;

function decode(v: string): string {
  return v
    .replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function text(xml: string, tag: string): string {
  return decode(blocks(xml, tag)[0] ?? '');
}
