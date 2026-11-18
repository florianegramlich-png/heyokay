/**
 * The anonymous device token, kept in this browser only (like the phone app keeps it on the device).
 * No account, no cookie: the server knows this browser only by the token.
 */
const TOKEN_KEY = 'heyokay.token';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // private mode or blocked storage
  }
}

export const session = {
  getToken(): string | null {
    try { return storage()?.getItem(TOKEN_KEY) ?? null; } catch { return null; }
  },
  setToken(token: string) {
    try { storage()?.setItem(TOKEN_KEY, token); } catch { /* the session lasts until the tab closes */ }
  },
  clear() {
    try { storage()?.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
  },
};
