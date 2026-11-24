import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { hashToken } from './db.js';

/**
 * Alert Desk accounts (PRD 6.2 step 5): one login per reviewer, so every approval and rejection
 * in the decision log names a person, and review time can be measured.
 *
 * - Passwords: scrypt (N=2^15, r=8, p=1), 16-byte salt, stored as `scrypt$N$r$p$salt$hash`.
 * - Sessions: a random 32-byte value in an HttpOnly, Secure, SameSite=Strict cookie limited to
 *   /admin; only its SHA-256 is stored. 12 hours, then sign in again.
 * - Cookie-authenticated requests must also send `x-desk: 1`, which a form on another site can't.
 * - The admin token keeps working (setup, scripts, adding reviewers).
 */
export const SESSION_COOKIE = 'hok_desk';
export const SESSION_HOURS = 12;
export const MIN_PASSWORD_LENGTH = 12;

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
  return new Promise((resolve, reject) => scryptCb(password.normalize('NFC'), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to compare against when the email is unknown, so the answer takes as long either way. */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString('hex')));

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function sessionCookie(token: string, maxAgeS = SESSION_HOURS * 3600): string {
  return `${SESSION_COOKIE}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;
}

export const clearedCookie = () => `${SESSION_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function readCookie(header: string | undefined, name = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** Same-length constant-time comparison for the admin token. */
export function tokenEquals(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** At most `max` failed sign-ins per key in `windowMs` (per email and per IP). In memory: per machine. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 15 * 60_000) {}
  blocked(keys: string[], now: number): boolean {
    return keys.some((k) => (this.fails.get(k) ?? []).filter((t) => now - t < this.windowMs).length >= this.max);
  }
  fail(keys: string[], now: number) {
    for (const k of keys) this.fails.set(k, [...(this.fails.get(k) ?? []).filter((t) => now - t < this.windowMs), now]);
  }
  clear(keys: string[]) {
    for (const k of keys) this.fails.delete(k);
  }
}

/** Review-time summary (target: under 3 minutes) from desk decisions that carry `reviewSeconds`. */
export const REVIEW_TARGET_S = 180;
export function reviewTimes(seconds: number[]): { reviews: number; medianS: number | null; p90S: number | null; withinTarget: number | null; targetS: number } {
  const s = [...seconds].sort((a, b) => a - b);
  const q = (f: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)] : null);
  return {
    reviews: s.length,
    medianS: q(0.5),
    p90S: q(0.9),
    withinTarget: s.length ? s.filter((x) => x <= REVIEW_TARGET_S).length / s.length : null,
    targetS: REVIEW_TARGET_S,
  };
}
