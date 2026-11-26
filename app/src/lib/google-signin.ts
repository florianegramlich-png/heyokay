/**
 * Sign in with Google on the phone (PRD 5.3): the flow around react-native-nitro-google-signin
 * (Android Credential Manager, Google Sign-In SDK on iOS), kept free of native imports so it can be
 * tested with Node. The native module is passed in; `google-native.ts` loads it.
 *
 * The client ids come from the build (app.config.ts → extra.google): `GOOGLE_WEB_CLIENT_ID` and
 * `GOOGLE_IOS_CLIENT_ID`. Without both, the native code isn't linked and no button shows.
 */

export interface GoogleIds { webClientId: string; iosClientId: string }

type ResponseType = 'success' | 'noSavedCredentialFound' | 'cancelled';
export interface GoogleResponse { type: ResponseType; data: { idToken: string } | null }

/** The part of `GoogleOneTapSignIn` we use. */
export interface GoogleModule {
  configure(p: { webClientId: string; iosClientId?: string | null; nonce?: string | null; scopes?: string[] | null; autoSelectOnSignIn?: boolean }): void;
  checkPlayServices(showErrorResolutionDialog?: boolean): Promise<void>;
  signIn(): Promise<GoogleResponse>;
  createAccount(): Promise<GoogleResponse>;
  presentExplicitSignIn(): Promise<GoogleResponse>;
}

export type GoogleOutcome = { kind: 'token'; idToken: string } | { kind: 'cancelled' } | { kind: 'failed' };

/** `com.googleusercontent.apps.<id>`, the iOS URL scheme Google's SDK returns to. */
export function reversedClientId(clientId: string): string {
  return clientId.trim().split('.').reverse().join('.');
}

/** Client ids from the build environment, or null (Google sign-in off in this build). */
export function googleIdsFromEnv(env: Record<string, string | undefined>): GoogleIds | null {
  const web = env.GOOGLE_WEB_CLIENT_ID?.trim() ?? '';
  const ios = env.GOOGLE_IOS_CLIENT_ID?.trim() ?? '';
  const ok = (id: string) => /^[\w-]+\.apps\.googleusercontent\.com$/.test(id);
  return ok(web) && ok(ios) ? { webClientId: web, iosClientId: ios } : null;
}

/** Native errors that mean "the person closed the sheet": nothing to say. */
const CANCEL_CODES = new Set(['SIGN_IN_CANCELLED', 'ERR_REQUEST_CANCELED']);

/**
 * Get an ID token whose `nonce` claim is `nonceHashed` (SHA-256 hex of the raw nonce the server checks).
 * Order recommended by the library: an account already used with this app, then any Google account
 * on the phone, then Google's own sign-in screen.
 */
export async function googleIdToken(mod: GoogleModule, ids: GoogleIds, nonceHashed: string, android: boolean): Promise<GoogleOutcome> {
  try {
    // configure() takes the nonce, so it runs before every attempt with a fresh one.
    mod.configure({ webClientId: ids.webClientId, iosClientId: ids.iosClientId, nonce: nonceHashed, scopes: ['email'], autoSelectOnSignIn: false });
    if (android) await mod.checkPlayServices(true);
    let r = await mod.signIn();
    if (r.type === 'noSavedCredentialFound') r = await mod.createAccount();
    if (r.type === 'noSavedCredentialFound') r = await mod.presentExplicitSignIn();
    if (r.type === 'cancelled') return { kind: 'cancelled' };
    if (r.type === 'success' && r.data?.idToken) return { kind: 'token', idToken: r.data.idToken };
    return { kind: 'failed' };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === 'string' && CANCEL_CODES.has(code) ? { kind: 'cancelled' } : { kind: 'failed' };
  }
}
