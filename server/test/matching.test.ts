import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store } from '../src/store.js';
import { match } from '../src/pipeline/rank.js';
import { storeBackends } from './backends.js';

const OSTKREUZ = { lat: 52.503, lon: 13.469, radiusM: 1000 };
const BUFFER = 1500;
/** Metres → degrees of latitude (good enough to place test users). */
const north = (m: number) => m / 111_195;

describe.each(storeBackends())('usersNear ($name)', (backend) => {
  let store: Store;
  beforeEach(async () => { store = await backend.make(); });
  afterEach(async () => { await store.close(); });

  async function userAt(lat: number | null, lon: number | null) {
    const { user } = await store.createUser(null);
    if (lat != null && lon != null) await store.updateLocation(user.id, lat, lon);
    return user.id;
  }

  it('finds users by current location and by saved places, not others', async () => {
    const inside = await userAt(OSTKREUZ.lat + north(2000), OSTKREUZ.lon); // 2.0 km: within 1 km + 1.5 km buffer
    const outside = await userAt(OSTKREUZ.lat + north(2700), OSTKREUZ.lon); // 2.7 km
    const munich = await userAt(48.1374, 11.5755);
    const noLocation = await userAt(null, null);
    const placeHit = await userAt(48.1374, 11.5755); // in Munich, but Mama lives near Ostkreuz
    await store.addPlace(placeHit, 'Mama', OSTKREUZ.lat + north(1400), OSTKREUZ.lon, 500); // 1.4 km ≤ 1 km + 500 m
    const placeMiss = await userAt(null, null);
    await store.addPlace(placeMiss, 'Büro', OSTKREUZ.lat + north(1600), OSTKREUZ.lon, 500); // 1.6 km > 1.5 km
    await store.addPlace(placeHit, 'Arbeit', 48.14, 11.58, 300); // a second, far-away place comes along too

    const found = await store.usersNear(OSTKREUZ, BUFFER, new Date());
    const ids = found.map((f) => f.user.id).sort();
    expect(ids).toEqual([inside, placeHit].sort());
    expect(ids).not.toContain(outside);
    expect(ids).not.toContain(munich);
    expect(ids).not.toContain(noLocation);
    expect(ids).not.toContain(placeMiss);
    expect(found.find((f) => f.user.id === placeHit)!.places.map((p) => p.label).sort()).toEqual(['Arbeit', 'Mama']);
  });

  it('ignores a current location older than 24 hours, but not saved places', async () => {
    const here = await userAt(OSTKREUZ.lat, OSTKREUZ.lon);
    const withPlace = await userAt(OSTKREUZ.lat, OSTKREUZ.lon);
    await store.addPlace(withPlace, 'Zuhause', OSTKREUZ.lat, OSTKREUZ.lon, 500);
    const later = new Date(Date.now() + 25 * 3600_000);
    expect((await store.usersNear(OSTKREUZ, BUFFER, later)).map((f) => f.user.id)).toEqual([withPlace]);
    expect((await store.usersNear(OSTKREUZ, BUFFER, new Date())).map((f) => f.user.id).sort()).toEqual([here, withPlace].sort());
  });

  it('agrees with the pipeline rule for every user, including ones right at the edge', async () => {
    // Deterministic pseudo-random users and places around the event, many of them near the boundary.
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const edge = OSTKREUZ.radiusM + BUFFER;
    for (let i = 0; i < 60; i++) {
      const d = edge + (rnd() - 0.5) * 200; // within ±100 m of the edge
      const bearing = rnd() * 2 * Math.PI;
      const lat = OSTKREUZ.lat + north(d * Math.cos(bearing));
      const lon = OSTKREUZ.lon + north(d * Math.sin(bearing)) / Math.cos((OSTKREUZ.lat * Math.PI) / 180);
      const id = await userAt(lat, lon);
      if (i % 3 === 0) {
        const r = 100 + Math.round(rnd() * 900);
        const pd = OSTKREUZ.radiusM + r + (rnd() - 0.5) * 100;
        await store.addPlace(id, `P${i}`, OSTKREUZ.lat - north(pd), OSTKREUZ.lon, r);
      }
    }
    const now = new Date();
    const event = { ...OSTKREUZ, endsAt: null } as any;
    const all = await store.allUsers();
    const expected = (await Promise.all(all.map(async (u) => (match(u, await store.places(u.id), event, BUFFER, now) ? u.id : null))))
      .filter(Boolean).sort();
    const found = await store.usersNear(OSTKREUZ, BUFFER, now);
    const matched = found.filter((f) => match(f.user, f.places, event, BUFFER, now)).map((f) => f.user.id).sort();
    expect(expected.length).toBeGreaterThan(5);
    expect(expected.length).toBeLessThan(all.length - 5);
    expect(matched).toEqual(expected);
  });
});
