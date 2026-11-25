import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * API hardening (PRD 11): who the client is, request rate limits, and security headers.
 * No new dependency: small, in-memory, per machine.
 */

export interface HardeningOptions {
  /** Requests per minute from one address (0 = off). */
  ipPerMin: number;
  /** Requests per minute with one bearer token (0 = off). */
  tokenPerMin: number;
  /**
   * Header with the client's address set by our own edge proxy (Fly: `fly-client-ip`). Only used
   * when set: otherwise anyone could pick their own address and walk around the limits.
   */
  clientIpHeader?: string | null;
}

export const DEFAULT_HARDENING: HardeningOptions = { ipPerMin: 300, tokenPerMin: 120, clientIpHeader: null };

/** Biggest request body any route takes (prefs, places, a desk alert are a few KB). */
export const BODY_LIMIT_BYTES = 64 * 1024;

export function clientIp(req: FastifyRequest, header?: string | null): string {
  const v = header ? req.headers[header.toLowerCase()] : undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return (s && s.trim()) || req.ip;
}

/** Fixed one-minute windows. Old windows are dropped as the clock moves on, so memory stays small. */
export class RateCounter {
  private counts = new Map<string, number>();
  private window = -1;
  constructor(private perMin: number) {}

  /** Counts one request; returns seconds until the window ends if over the limit, else 0. */
  hit(key: string, nowMs: number): number {
    if (this.perMin <= 0) return 0;
    const w = Math.floor(nowMs / 60_000);
    if (w !== this.window) { this.window = w; this.counts.clear(); }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n > this.perMin ? Math.max(1, Math.ceil(((w + 1) * 60_000 - nowMs) / 1000)) : 0;
  }
}

/** Routes that are never limited: health checks from Fly and the uptime monitor. */
const UNLIMITED = new Set(['/health']);

const JSON_CSP = "default-src 'none'; frame-ancestors 'none'";
/** The Alert Desk page: its own inline script and styles, its own API, nothing else. */
const DESK_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function harden(app: FastifyInstance, opts: HardeningOptions, now: () => Date) {
  const byIp = new RateCounter(opts.ipPerMin);
  const byToken = new RateCounter(opts.tokenPerMin);

  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (UNLIMITED.has(route) || req.method === 'OPTIONS') return;
    const t = now().getTime();
    let wait = byIp.hit(`ip:${clientIp(req, opts.clientIpHeader)}`, t);
    const auth = req.headers.authorization;
    if (!wait && auth) wait = byToken.hit(`t:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}`, t);
    if (wait) {
      reply.header('retry-after', String(wait));
      return reply.code(429).send({ error: 'too_many_requests' });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    const route = req.routeOptions.url ?? '';
    reply.header('content-security-policy', route === '/admin' ? DESK_CSP : JSON_CSP);
    // Personal answers and desk data must not sit in shared caches.
    if (route.startsWith('/v1/me') || route.startsWith('/v1/alerts') || route.startsWith('/v1/auth') || route.startsWith('/admin')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
