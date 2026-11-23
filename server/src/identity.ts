import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';
import { fetchWithTimeout } from './http.js';
import type { IdentityProvider } from './store.js';

/**
 * Sign in with Apple and Google (PRD 5.3, 7.1): checks the identity token (a JWT) the app gets
 * from Apple's or Google's sign-in sheet, without any SDK.
 *
 * - signature: RS256 against the provider's published keys (JWKS), cached; an unknown key id
 *   triggers one refetch (at most once a minute), so key rotation just works;
 * - issuer: Apple `https://appleid.apple.com`, Google `accounts.google.com` (with or without https);
 * - audience: one of our client ids (iOS bundle id, Android/web client ids), from the settings;
 * - expiry and issue time, with 60 s of clock slack.
 *
 * What comes back is only the provider's stable user id (`sub`) and the email, with whether the
 * provider has verified it. Names, pictures and anything else in the token are ignored.
 */

export interface IdentityClaims { sub: string; email: string | null; emailVerified: boolean; /** The token's `nonce` claim, if any. */ nonce: string | null }

export class IdentityError extends Error {
  constructor(public code: 'invalid_token' | 'provider_unavailable', message: string) { super(message); }
}

export interface ProviderSpec { jwksUrl: string; issuers: string[] }

export const PROVIDERS: Record<IdentityProvider, ProviderSpec> = {
  apple: { jwksUrl: 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'] },
  google: { jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['accounts.google.com', 'https://accounts.google.com'] },
};

const SKEW_S = 60;
const MIN_REFETCH_MS = 60_000;
const DEFAULT_TTL_MS = 3600_000;

export interface VerifierOptions {
  /** Accepted `aud` values; must not be empty. */
  audiences: string[];
  spec?: ProviderSpec;
  fetch?: (url: string) => Promise<Response>;
  now?: () => Date;
}

const b64json = (part: string): any => {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
};

export class IdentityVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private lastAttempt = -Infinity;
  private ttlMs = DEFAULT_TTL_MS;
  private inflight: Promise<void> | null = null;
  private readonly spec: ProviderSpec;
  private readonly audiences: Set<string>;
  private readonly fetchFn: (url: string) => Promise<Response>;
  private readonly now: () => Date;

  constructor(readonly provider: IdentityProvider, opts: VerifierOptions) {
    if (!opts.audiences.length) throw new Error(`${provider} sign-in: no client ids configured`);
    this.spec = opts.spec ?? PROVIDERS[provider];
    this.audiences = new Set(opts.audiences);
    this.fetchFn = opts.fetch ?? ((url) => fetchWithTimeout(url));
    this.now = opts.now ?? (() => new Date());
  }

  async verify(token: string): Promise<IdentityClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new IdentityError('invalid_token', 'not a JWT');
    const [h, p, s] = parts;
    const header = b64json(h);
    const claims = b64json(p);
    if (!header || !claims || typeof claims !== 'object') throw new IdentityError('invalid_token', 'unreadable token');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new IdentityError('invalid_token', `unsupported alg ${header.alg}`);

    const key = await this.key(header.kid);
    if (!key) throw new IdentityError('invalid_token', 'unknown key id');
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw new IdentityError('invalid_token', 'bad signature');

    if (!this.spec.issuers.includes(claims.iss)) throw new IdentityError('invalid_token', 'wrong issuer');
    const auds: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.some((a) => typeof a === 'string' && this.audiences.has(a))) throw new IdentityError('invalid_token', 'wrong audience');
    const nowS = this.now().getTime() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < nowS) throw new IdentityError('invalid_token', 'expired');
    if (typeof claims.iat === 'number' && claims.iat - SKEW_S > nowS) throw new IdentityError('invalid_token', 'issued in the future');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new IdentityError('invalid_token', 'no subject');

    const email = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email : null;
    // Apple sends "true"/"false" as strings, Google as booleans.
    const emailVerified = email != null && (claims.email_verified === true || claims.email_verified === 'true');
    return { sub: claims.sub, email, emailVerified, nonce: typeof claims.nonce === 'string' ? claims.nonce : null };
  }

  private async key(kid: string): Promise<KeyObject | undefined> {
    const now = this.now().getTime();
    const stale = !this.fetchedAt || now - this.fetchedAt > this.ttlMs || !this.keys.has(kid);
    // At most one fetch a minute, also after a failure (no hammering a provider that is down).
    if (stale && now - this.lastAttempt > MIN_REFETCH_MS) {
      this.lastAttempt = now;
      try {
        await this.refresh();
      } catch (err) {
        // Keep working with the cached keys if we have the one we need.
        if (!this.keys.has(kid)) throw new IdentityError('provider_unavailable', `${this.provider} keys: ${(err as Error).message}`);
      }
    }
    if (!this.keys.size) throw new IdentityError('provider_unavailable', `${this.provider} keys not loaded`);
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const res = await this.fetchFn(this.spec.jwksUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string; use?: string }> };
        if (!Array.isArray(body?.keys)) throw new Error('no keys in answer');
        const keys = new Map<string, KeyObject>();
        for (const jwk of body.keys) {
          if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.use && jwk.use !== 'sig')) continue;
          try { keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* skip a broken key */ }
        }
        if (!keys.size) throw new Error('no usable keys');
        this.keys = keys;
        this.fetchedAt = this.now().getTime();
        const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
        this.ttlMs = Number.isFinite(maxAge) ? Math.min(Math.max(maxAge * 1000, 5 * 60_000), 24 * 3600_000) : DEFAULT_TTL_MS;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

/** Client ids from a comma-separated setting; null when unset (that provider is off). */
export function parseClientIds(raw: string | undefined): string[] | null {
  const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * Replay protection: the app makes a random nonce, gives Apple/Google its SHA-256 (hex), and sends
 * the raw nonce with the token. Only the app that asked for this token knows the raw value.
 */
export function nonceHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function nonceMatches(claims: Pick<IdentityClaims, 'nonce'>, raw: string): boolean {
  if (!claims.nonce) return false;
  const a = Buffer.from(claims.nonce);
  const b = Buffer.from(nonceHash(raw));
  return a.length === b.length && timingSafeEqual(a, b);
}
