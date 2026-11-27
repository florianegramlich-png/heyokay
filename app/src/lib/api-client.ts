import type { Alert, AlertDetail, Category, Feedback, SavedPlace, TechService, UserPrefs } from './types';
import type { Provider, Providers } from './signin';
import type { Family, FamilyInvite } from './family';

/**
 * The Hey-Okay server API as a pure function of fetch, the device token and the base URL, so it can
 * be tested without Expo (test/api.test.ts). `lib/api.ts` wires it to the app's session and config.
 * Same shape as web/lib/api.ts (minus the push token, which the browser has none of).
 */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Fetch = typeof fetch;
const enc = encodeURIComponent;

export function createApi(fetchImpl: Fetch, getToken: () => Promise<string | null> | string | null, base: string) {
  async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const token = await getToken();
      if (!token) throw new ApiError(401, 'no device token');
      headers.authorization = `Bearer ${token}`;
    }
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? res.statusText);
    return json as T;
  }

  return {
    register: (prefs: UserPrefs, pushToken: string | null) =>
      request<{ userId: string; token: string; prefs: UserPrefs }>('POST', '/v1/devices', { prefs, pushToken }, false),
    me: () => request<{ userId: string; prefs: UserPrefs; places: SavedPlace[]; hasLocation: boolean; account: { email: string } | null }>('GET', '/v1/me'),
    // Sign-in with an email code (server: auth.ts). The device token stays the same.
    emailStart: (email: string) => request<{ ok: true }>('POST', '/v1/auth/email/start', { email }),
    emailVerify: (email: string, code: string) =>
      request<{ userId: string; prefs: UserPrefs; places: SavedPlace[]; account: { email: string } }>('POST', '/v1/auth/email/verify', { email, code }),
    signOut: () => request<{ userId: string; token: string; prefs: UserPrefs }>('POST', '/v1/auth/signout'),
    /** Anonymous app events (lib/analytics.ts): event names and the platform, no token. */
    events: (body: { platform: 'ios' | 'android' | 'web'; events: { name: string }[] }) => request<{ ok: true }>('POST', '/v1/events', body, false),
    /** Which sign-in methods the server has switched on (public). */
    authProviders: () => request<Providers>('GET', '/v1/auth/providers', undefined, false),
    /** Sign in with Apple / Google: the provider's identity token and the raw nonce (lib/signin.ts). */
    signInWith: (provider: Provider, idToken: string, nonce: string) =>
      request<{ userId: string; prefs: UserPrefs; places: SavedPlace[]; account: { email: string } }>('POST', `/v1/auth/${enc(provider)}`, { idToken, nonce }),
    updatePrefs: (prefs: Partial<UserPrefs>) => request<{ prefs: UserPrefs }>('PUT', '/v1/me/prefs', prefs),
    updatePushToken: (pushToken: string | null) => request<{ ok: true }>('PUT', '/v1/me/push-token', { pushToken }),
    sendLocation: (lat: number, lon: number, firstSync = false) =>
      request<{ ok: true; newAlerts: number }>('POST', '/v1/me/location', { lat, lon, firstSync }),
    places: () => request<{ places: SavedPlace[] }>('GET', '/v1/me/places'),
    /** Active events nearby, for OS geofences (server: GET /v1/me/regions). */
    regions: () => request<{ regions: { id: string; lat: number; lon: number; radiusM: number }[] }>('GET', '/v1/me/regions'),
    addPlace: (label: string, lat: number, lon: number, radiusM = 500) =>
      request<{ place: SavedPlace }>('POST', '/v1/me/places', { label, lat, lon, radiusM }),
    deletePlace: (id: string) => request<{ ok: true }>('DELETE', `/v1/me/places/${enc(id)}`),
    /** Share one of your places with your family, or stop (PATCH /v1/me/places/:id). */
    sharePlace: (id: string, shared: boolean) => request<{ place: SavedPlace }>('PATCH', `/v1/me/places/${enc(id)}`, { shared }),
    // Family sharing (server: family.ts). `name` is how the others see you.
    family: () => request<{ family: Family | null }>('GET', '/v1/me/family'),
    startFamily: (name: string) => request<{ family: Family }>('POST', '/v1/me/family', { name }),
    familyInvite: () => request<FamilyInvite>('POST', '/v1/me/family/invite', {}),
    joinFamily: (code: string, name: string) => request<{ family: Family }>('POST', '/v1/me/family/join', { code, name }),
    leaveFamily: () => request<{ ok: true }>('DELETE', '/v1/me/family'),
    removeFamilyMember: (memberId: string) => request<{ family: Family }>('DELETE', `/v1/me/family/members/${enc(memberId)}`),
    deleteAccount: () => request<{ ok: true }>('DELETE', '/v1/me'),
    alerts: () => request<{ alerts: Alert[] }>('GET', '/v1/me/alerts'),
    /** Past alerts, one per incident; `q` matches words, `category` narrows by topic. */
    history: (opts: { q?: string; category?: Category } = {}) => {
      const qs = new URLSearchParams();
      if (opts.q) qs.set('q', opts.q);
      if (opts.category) qs.set('category', opts.category);
      const s = qs.toString();
      return request<{ alerts: Alert[] }>('GET', `/v1/me/history${s ? `?${s}` : ''}`);
    },
    /** Services whose outages can be followed one by one ("only the services I use"). */
    services: () => request<{ services: TechService[] }>('GET', '/v1/services', undefined, false),
    alert: (id: string) => request<AlertDetail>('GET', `/v1/alerts/${enc(id)}`),
    feedback: (id: string, value: Feedback) => request<{ ok: true }>('POST', `/v1/alerts/${enc(id)}/feedback`, { value }),
  };
}

export type Api = ReturnType<typeof createApi>;
