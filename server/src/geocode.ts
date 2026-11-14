export interface GeoResult {
  lat: number;
  lon: number;
  radiusM: number;
  name: string;
}

export interface Geocoder {
  geocode(place: string): Promise<GeoResult | null>;
}

/**
 * Offline gazetteer: Berlin districts and the first launch cities. Used in tests, as a fallback
 * when the network geocoder fails, and to find place names in text when no LLM is configured.
 */
export const GAZETTEER: GeoResult[] = [
  { name: 'Berlin', lat: 52.52, lon: 13.405, radiusM: 20000 },
  { name: 'Mitte', lat: 52.5306, lon: 13.3889, radiusM: 3500 },
  { name: 'Friedrichshain', lat: 52.5155, lon: 13.4549, radiusM: 2500 },
  { name: 'Kreuzberg', lat: 52.4986, lon: 13.4034, radiusM: 2500 },
  { name: 'Prenzlauer Berg', lat: 52.5388, lon: 13.4244, radiusM: 2500 },
  { name: 'Neukölln', lat: 52.4811, lon: 13.4350, radiusM: 3500 },
  { name: 'Charlottenburg', lat: 52.5167, lon: 13.3041, radiusM: 3000 },
  { name: 'Spandau', lat: 52.5511, lon: 13.1999, radiusM: 5000 },
  { name: 'Pankow', lat: 52.5693, lon: 13.4010, radiusM: 4000 },
  { name: 'Lichtenberg', lat: 52.5155, lon: 13.4997, radiusM: 3500 },
  { name: 'Tempelhof', lat: 52.4664, lon: 13.3842, radiusM: 3000 },
  { name: 'Schöneberg', lat: 52.4832, lon: 13.3550, radiusM: 2500 },
  { name: 'Steglitz', lat: 52.4560, lon: 13.3220, radiusM: 3000 },
  { name: 'Wedding', lat: 52.5503, lon: 13.3597, radiusM: 2500 },
  { name: 'Moabit', lat: 52.5302, lon: 13.3420, radiusM: 2000 },
  { name: 'Treptow', lat: 52.4930, lon: 13.4590, radiusM: 3500 },
  { name: 'Köpenick', lat: 52.4454, lon: 13.5747, radiusM: 5000 },
  { name: 'Marzahn', lat: 52.5446, lon: 13.5643, radiusM: 3500 },
  { name: 'Reinickendorf', lat: 52.5869, lon: 13.3329, radiusM: 4000 },
  { name: 'Zehlendorf', lat: 52.4340, lon: 13.2590, radiusM: 4000 },
  { name: 'Ostkreuz', lat: 52.5031, lon: 13.4690, radiusM: 600 },
  { name: 'Alexanderplatz', lat: 52.5219, lon: 13.4132, radiusM: 600 },
  { name: 'Hauptbahnhof', lat: 52.5251, lon: 13.3694, radiusM: 600 },
  { name: 'München', lat: 48.1374, lon: 11.5755, radiusM: 15000 },
  { name: 'Hamburg', lat: 53.5511, lon: 9.9937, radiusM: 15000 },
  { name: 'Köln', lat: 50.9375, lon: 6.9603, radiusM: 12000 },
];

export class GazetteerGeocoder implements Geocoder {
  async geocode(place: string) {
    return findInText(place);
  }
}

/** Most specific gazetteer entry mentioned in the text (smallest radius wins). */
export function findInText(text: string): GeoResult | null {
  const lower = text.toLowerCase();
  const hits = GAZETTEER.filter((g) => new RegExp(`(^|[^\\p{L}])${escape(g.name.toLowerCase())}($|[^\\p{L}])`, 'u').test(lower));
  return hits.sort((a, b) => a.radiusM - b.radiusM)[0] ?? null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** OpenStreetMap Nominatim, restricted to Germany/Austria/Switzerland. Respect their usage policy (1 req/s, real UA). */
export class NominatimGeocoder implements Geocoder {
  private cache = new Map<string, GeoResult | null>();
  private last = 0;
  constructor(private url: string, private userAgent: string, private fallback: Geocoder = new GazetteerGeocoder()) {}

  async geocode(place: string): Promise<GeoResult | null> {
    const key = place.trim().toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key)!;
    let result: GeoResult | null = null;
    try {
      const wait = 1100 - (Date.now() - this.last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const q = new URLSearchParams({ q: place, format: 'jsonv2', limit: '1', countrycodes: 'de,at,ch' });
      const res = await fetch(`${this.url}?${q}`, { headers: { 'User-Agent': this.userAgent } });
      if (res.ok) {
        const [hit] = (await res.json()) as any[];
        if (hit) {
          const bb = (hit.boundingbox ?? []).map(Number);
          const spanM = bb.length === 4 ? Math.max(Math.abs(bb[1] - bb[0]) * 111_000, Math.abs(bb[3] - bb[2]) * 70_000) / 2 : 500;
          result = { lat: Number(hit.lat), lon: Number(hit.lon), radiusM: Math.min(Math.max(spanM, 300), 20_000), name: hit.display_name };
        }
      }
    } catch (err) {
      console.warn('[geocode] nominatim failed:', (err as Error).message);
    }
    result ??= await this.fallback.geocode(place);
    this.cache.set(key, result);
    return result;
  }
}
