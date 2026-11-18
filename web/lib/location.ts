/** Rounded to 3 decimals (about 100 m), like the phone app. Only the latest point is ever sent. */
export function roundCoord(x: number) {
  return Math.round(x * 1000) / 1000;
}

export type LocationResult = { ok: true; lat: number; lon: number } | { ok: false; reason: 'denied' | 'unavailable' };

export function currentPosition(timeoutMs = 15_000): Promise<LocationResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve({ ok: false, reason: 'unavailable' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ ok: true, lat: roundCoord(p.coords.latitude), lon: roundCoord(p.coords.longitude) }),
      (e) => resolve({ ok: false, reason: e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: timeoutMs },
    );
  });
}

/**
 * Address → coordinates for saved places, via OpenStreetMap Nominatim (one request per search,
 * on submit only, as their usage policy asks). Limited to Germany.
 */
export async function geocodeAddress(q: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<{ lat: number; lon: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=de&q=${encodeURIComponent(q)}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const [hit] = (await res.json()) as Array<{ lat: string; lon: string }>;
  return hit ? { lat: roundCoord(Number(hit.lat)), lon: roundCoord(Number(hit.lon)) } : null;
}
