/** A user's current location older than this is not used for matching (saved places still are). */
export const LOCATION_MAX_AGE_MS = 24 * 3600_000;
/** Largest radius a saved place may have (API limit; a CHECK constraint in Postgres). */
export const MAX_PLACE_RADIUS_M = 5000;

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Centre and enclosing radius for a polygon given as [lon, lat] pairs (GeoJSON order). */
export function polygonCircle(ring: [number, number][]): { lat: number; lon: number; radiusM: number } {
  if (ring.length === 0) throw new Error('empty polygon');
  let lat = 0, lon = 0;
  for (const [x, y] of ring) { lon += x; lat += y; }
  lat /= ring.length; lon /= ring.length;
  let radiusM = 0;
  for (const [x, y] of ring) radiusM = Math.max(radiusM, distanceM(lat, lon, y, x));
  return { lat, lon, radiusM: Math.max(radiusM, 500) };
}

/** Merge several circles into one enclosing circle (approximate). */
export function enclosingCircle(circles: { lat: number; lon: number; radiusM: number }[]) {
  if (circles.length === 1) return circles[0];
  const lat = circles.reduce((s, c) => s + c.lat, 0) / circles.length;
  const lon = circles.reduce((s, c) => s + c.lon, 0) / circles.length;
  const radiusM = Math.max(...circles.map((c) => distanceM(lat, lon, c.lat, c.lon) + c.radiusM));
  return { lat, lon, radiusM };
}

/** A polygon outline as [lon, lat] pairs (GeoJSON order). */
export type Ring = [number, number][];

/** Ray casting. Ring in [lon, lat]. */
export function pointInRing(lat: number, lon: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Metres from a point to the nearest of several polygon outlines; 0 when inside one.
 * Uses a local flat projection around the point — accurate to well under 1% at alert scales.
 */
export function distanceToAreasM(lat: number, lon: number, rings: Ring[]): number {
  let best = Infinity;
  const kx = R * rad(1) * Math.cos(rad(lat));
  const ky = R * rad(1);
  for (const ring of rings) {
    if (ring.length < 3) continue;
    if (pointInRing(lat, lon, ring)) return 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = (ring[j][0] - lon) * kx, ay = (ring[j][1] - lat) * ky;
      const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/** Keep stored outlines small: at most `max` points per ring, first and last kept. */
export function thinRing(ring: Ring, max = 300): Ring {
  if (ring.length <= max) return ring;
  const step = Math.ceil(ring.length / max);
  const out = ring.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
  return out;
}

/** Outer rings of a GeoJSON Polygon / MultiPolygon. */
export function outerRings(geometry: { type: string; coordinates: any } | null | undefined): Ring[] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates[0] ? [geometry.coordinates[0]] : [];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((p: any) => p[0]).filter(Boolean);
  return [];
}
