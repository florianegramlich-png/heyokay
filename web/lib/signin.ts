/**
 * Sign in with Apple / Google: the small shared part of the phone app and the web app
 * (same file in app/src/lib and web/lib; tested in web/test).
 *
 * Replay protection: we make a random nonce, give Apple/Google its SHA-256 (hex), and send the
 * raw nonce to our server with the identity token. The server checks the token's nonce is the
 * hash of what we sent (server/src/identity.ts).
 */
export type Provider = 'apple' | 'google';

export interface Providers { email: boolean; apple: boolean; google: boolean }

export const NO_PROVIDERS: Providers = { email: false, apple: false, google: false };

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `random(n)` gives n secure random bytes; `sha256Hex` hashes a string to lowercase hex. */
export async function makeNonce(random: (n: number) => Uint8Array, sha256Hex: (s: string) => Promise<string>): Promise<{ raw: string; hashed: string }> {
  const raw = toHex(random(16));
  return { raw, hashed: await sha256Hex(raw) };
}

export type ProviderErrorKey = 'acc.err.providerOff' | 'acc.err.noEmail' | 'acc.err.conflict' | 'acc.err.provider' | 'acc.err.generic';

/** Server answer → message for people. */
export function providerErrorKey(status: number, code: string): ProviderErrorKey {
  if (status === 503) return 'acc.err.providerOff';
  if (code === 'email_required') return 'acc.err.noEmail';
  if (code === 'account_conflict') return 'acc.err.conflict';
  if (code === 'invalid_token') return 'acc.err.provider';
  return 'acc.err.generic';
}

/** Which buttons to show: the server must have the provider on, and this client must be able to use it. */
export function buttonsToShow(server: Providers, client: { apple: boolean; google: boolean }): Provider[] {
  return (['apple', 'google'] as const).filter((p) => server[p] && client[p]);
}
