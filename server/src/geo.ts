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
