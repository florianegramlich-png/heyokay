import Constants from 'expo-constants';
import { session } from './session';
import type { Alert, AlertDetail, Feedback, SavedPlace, UserPrefs } from './types';

/** EXPO_PUBLIC_API_URL wins (e.g. a tunnel to a local server), else app.json extra.apiUrl (the hosted server). */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'https://heyokay.fly.dev';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const token = await session.getToken();
    if (!token) throw new ApiError(401, 'no device token');
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? res.statusText);
  return json as T;
}

export const api = {
  register: (prefs: UserPrefs, pushToken: string | null) =>
    request<{ userId: string; token: string; prefs: UserPrefs }>('POST', '/v1/devices', { prefs, pushToken }, false),
  me: () => request<{ userId: string; prefs: UserPrefs; places: SavedPlace[]; hasLocation: boolean }>('GET', '/v1/me'),
  updatePrefs: (prefs: Partial<UserPrefs>) => request<{ prefs: UserPrefs }>('PUT', '/v1/me/prefs', prefs),
  updatePushToken: (pushToken: string | null) => request<{ ok: true }>('PUT', '/v1/me/push-token', { pushToken }),
  sendLocation: (lat: number, lon: number, firstSync = false) =>
    request<{ ok: true; newAlerts: number }>('POST', '/v1/me/location', { lat, lon, firstSync }),
  places: () => request<{ places: SavedPlace[] }>('GET', '/v1/me/places'),
  addPlace: (label: string, lat: number, lon: number, radiusM = 500) =>
    request<{ place: SavedPlace }>('POST', '/v1/me/places', { label, lat, lon, radiusM }),
  deletePlace: (id: string) => request<{ ok: true }>('DELETE', `/v1/me/places/${id}`),
  deleteAccount: () => request<{ ok: true }>('DELETE', '/v1/me'),
  alerts: () => request<{ alerts: Alert[] }>('GET', '/v1/me/alerts'),
  alert: (id: string) => request<AlertDetail>('GET', `/v1/alerts/${id}`),
  feedback: (id: string, value: Feedback) => request<{ ok: true }>('POST', `/v1/alerts/${id}/feedback`, { value }),
};
