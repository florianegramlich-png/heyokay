import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Store, Account, IdentityProvider } from './store.js';
import type { IdentityClaims } from './identity.js';
import type { Language, User } from './types.js';
import { fetchWithTimeout } from './http.js';

/**
 * Sign-in with an email code (PRD 5.3, 7.1), on top of the anonymous device token.
 *
 * A device always starts anonymous. Signing in attaches the device's data to an account, so a new
 * phone (or the web app) can sign in with the same email and see the same places and settings.
 * The code is 6 digits, valid 15 minutes, 5 tries; at most 5 codes per email per hour. Only a hash
 * of the code is stored. The email address is kept to send codes, and deleted with the account.
 */
export const CODE_TTL_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_SENDS_PER_HOUR = 5;

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Resend (https://resend.com/docs/api-reference/emails/send-email). Any provider with a send call fits here. */
export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string, private url = 'https://api.resend.com/emails') {}
  async send(to: string, subject: string, text: string) {
    const res = await fetchWithTimeout(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`mail provider → HTTP ${res.status}`);
  }
}

/** Keeps mails in memory — tests and the demo. Never used in production. */
export class MemoryMailer implements Mailer {
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(to: string, subject: string, text: string) { this.sent.push({ to, subject, text }); }
}

export class AuthError extends Error {
  constructor(public code: 'invalid_code' | 'rate_limited' | 'email_not_configured' | 'not_signed_in' | 'email_required' | 'account_conflict', public status: number) { super(code); }
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

const hashCode = (email: string, code: string) => createHash('sha256').update(`${email}:${code}`).digest('hex');

const MAIL = {
  de: (code: string) => ({
    subject: `${code} ist dein Hey-Okay-Code`,
    text: `Dein Anmeldecode für Hey-Okay: ${code}\n\nEr gilt 15 Minuten. Wenn du dich nicht anmelden wolltest, ignoriere diese E-Mail einfach.`,
  }),
  en: (code: string) => ({
    subject: `${code} is your Hey-Okay code`,
    text: `Your Hey-Okay sign-in code: ${code}\n\nIt is valid for 15 minutes. If you didn't try to sign in, just ignore this email.`,
  }),
};

/** Sends a new code. Same answer whether or not the email has an account (no account lookup by email). */
export async function startEmailSignIn(store: Store, mailer: Mailer | null, rawEmail: string, language: Language, now = new Date()) {
  if (!mailer) throw new AuthError('email_not_configured', 503);
  const email = normalizeEmail(rawEmail);
  const prev = await store.emailCode(email);
  const inWindow = prev && now.getTime() - Date.parse(prev.windowStart) < 3600_000;
  const sends = inWindow ? prev!.sends + 1 : 1;
  if (sends > MAX_SENDS_PER_HOUR) throw new AuthError('rate_limited', 429);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await store.saveEmailCode({
    email, codeHash: hashCode(email, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    attempts: 0, sends, windowStart: inWindow ? prev!.windowStart : now.toISOString(),
  });
  const m = MAIL[language](code);
  await mailer.send(email, m.subject, m.text);
}

/** True once for a correct, fresh code; wrong tries count toward the limit. */
export async function checkEmailCode(store: Store, rawEmail: string, code: string, now = new Date()): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  const c = await store.emailCode(email);
  if (!c || Date.parse(c.expiresAt) < now.getTime() || c.attempts >= MAX_ATTEMPTS) return false;
  const a = Buffer.from(c.codeHash, 'hex');
  const b = Buffer.from(hashCode(email, code.trim()), 'hex');
  if (a.length === b.length && timingSafeEqual(a, b)) {
    await store.deleteEmailCode(email); // one use
    return true;
  }
  await store.saveEmailCode({ ...c, attempts: c.attempts + 1 });
  return false;
}

/** Email-code sign-in: attach this device to the account for `email` (see `attach`). */
export async function signIn(store: Store, deviceToken: string, current: User, rawEmail: string): Promise<{ user: User; account: Account }> {
  const email = normalizeEmail(rawEmail);
  return attach(store, deviceToken, current, await store.accountByEmail(email), email);
}

/**
 * Sign in with Apple or Google, after the identity token has been checked (identity.ts).
 * - the provider's user id is already linked → that account;
 * - else an account with the same email, if the provider has verified the address → link to it
 *   (so email-code, Apple and Google all reach the same data);
 * - else a new account with that email, linked.
 * A verified email is needed to create or link an account; an account already linked to another
 * id of the same provider is never linked a second time (409).
 */
export async function signInWithIdentity(store: Store, deviceToken: string, current: User, provider: IdentityProvider, claims: IdentityClaims): Promise<{ user: User; account: Account }> {
  const linked = await store.accountByIdentity(provider, claims.sub);
  if (linked) return attach(store, deviceToken, current, linked, linked.email);
  if (!claims.email || !claims.emailVerified) throw new AuthError('email_required', 400);
  const email = normalizeEmail(claims.email);
  const byEmail = await store.accountByEmail(email);
  if (byEmail && (await store.identities(byEmail.id)).some((i) => i.provider === provider)) throw new AuthError('account_conflict', 409);
  const result = await attach(store, deviceToken, current, byEmail, email);
  await store.addIdentity(result.account.id, { provider, subject: claims.sub });
  return result;
}

/**
 * Attach this device to `existing` (or a new account for `email`):
 * - no account yet: the device's current data becomes the account (nothing moves);
 * - account exists and this device is anonymous: its places join the account, then the device
 *   signs in to the account's data (a new phone gets back its places and settings);
 * - this device is signed in to another account: it switches to this one.
 * Returns the user the device now belongs to.
 */
async function attach(store: Store, deviceToken: string, current: User, existing: Account | null, email: string): Promise<{ user: User; account: Account }> {
  const mine = await store.accountForUser(current.id);
  if (!existing) {
    if (mine) {
      // Signed in elsewhere: start a fresh user for the new account rather than renaming the old one.
      const { user, token: unused } = await store.createUser(null, current.prefs);
      await store.moveDevice(deviceToken, user.id);
      await store.removeDevice(unused); // the fresh user's own token is never handed out
      return { user, account: await store.createAccount(email, user.id) };
    }
    return { user: current, account: await store.createAccount(email, current.id) };
  }
  if (existing.userId === current.id) return { user: current, account: existing };
  if (mine) await store.moveDevice(deviceToken, existing.userId);
  else await store.mergeUserInto(current.id, existing.userId);
  const user = (await store.getUser(existing.userId))!;
  return { user, account: existing };
}

/**
 * Signs this device out: it gets a fresh anonymous identity (new token, default settings); the
 * account keeps its data for the next sign-in.
 */
export async function signOut(store: Store, deviceToken: string, current: User): Promise<{ user: User; token: string }> {
  if (!(await store.accountForUser(current.id))) throw new AuthError('not_signed_in', 400);
  await store.removeDevice(deviceToken);
  return store.createUser(null, { language: current.prefs.language, timezone: current.prefs.timezone });
}
