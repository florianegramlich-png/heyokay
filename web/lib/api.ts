import { session } from './session';
import type { Alert, AlertDetail, Category, Feedback, SavedPlace, TechService, UserPrefs } from './types';

/** The Hey-Okay server. NEXT_PUBLIC_API_URL for a local server (e.g. http://localhost:8787). */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'https://heyokay.fly.dev').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Fetch = typeof fetch;

export function createApi(fetchImpl: Fetch = (...a) => fetch(...a), getToken = () => session.getToken(), base = API_URL) {
  async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const token = getToken();
      if (!token) throw new ApiError(401, 'no device token');
      headers.authorization = `Bearer ${token}`;
    }
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? res.statusText);
    return json as T;
  }

  return {
    register: (prefs: UserPrefs) =>
      request<{ userId: string; token: string; prefs: UserPrefs }>('POST', '/v1/devices', { prefs, pushToken: null }, false),
    me: () => request<{ userId: string; prefs: UserPrefs; places: SavedPlace[]; hasLocation: boolean; account: { email: string } | null }>('GET', '/v1/me'),
    emailStart: (email: string) => request<{ ok: true }>('POST', '/v1/auth/email/start', { email }),
    emailVerify: (email: string, code: string) =>
      request<{ userId: string; prefs: UserPrefs; places: SavedPlace[]; account: { email: string } }>('POST', '/v1/auth/email/verify', { email, code }),
    signOut: () => request<{ userId: string; token: string; prefs: UserPrefs }>('POST', '/v1/auth/signout'),
    updatePrefs: (prefs: Partial<UserPrefs>) => request<{ prefs: UserPrefs }>('PUT', '/v1/me/prefs', prefs),
    sendLocation: (lat: number, lon: number, firstSync = false) =>
      request<{ ok: true; newAlerts: number }>('POST', '/v1/me/location', { lat, lon, firstSync }),
    addPlace: (label: string, lat: number, lon: number, radiusM = 500) =>
      request<{ place: SavedPlace }>('POST', '/v1/me/places', { label, lat, lon, radiusM }),
    deletePlace: (id: string) => request<{ ok: true }>('DELETE', `/v1/me/places/${encodeURIComponent(id)}`),
    deleteAccount: () => request<{ ok: true }>('DELETE', '/v1/me'),
    alerts: () => request<{ alerts: Alert[] }>('GET', '/v1/me/alerts'),
    /** Services whose outages can be followed one by one ("only the services I use"). */
    services: () => request<{ services: TechService[] }>('GET', '/v1/services', undefined, false),
    /** Past alerts, one per incident; `q` matches words, `category` narrows by topic. */
    history: (opts: { q?: string; category?: Category } = {}) => {
      const qs = new URLSearchParams();
      if (opts.q) qs.set('q', opts.q);
      if (opts.category) qs.set('category', opts.category);
      const s = qs.toString();
      return request<{ alerts: Alert[] }>('GET', `/v1/me/history${s ? `?${s}` : ''}`);
    },
    alert: (id: string) => request<AlertDetail>('GET', `/v1/alerts/${encodeURIComponent(id)}`),
    feedback: (id: string, value: Feedback) => request<{ ok: true }>('POST', `/v1/alerts/${encodeURIComponent(id)}/feedback`, { value }),
  };
}

export const api = createApi();
