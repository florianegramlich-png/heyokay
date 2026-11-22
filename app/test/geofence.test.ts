import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_ID, MAX_REGIONS, planRegions, reactTo, sameRegions } from '../src/lib/geofence.ts';

const here = { lat: 52.520008, lon: 13.404954 };
const ev = (i: number) => ({ id: `e${i}`, lat: 52.5 + i / 100, lon: 13.4, radiusM: 120 });
const place = (i: number) => ({ id: `p${i}`, lat: 52.4, lon: 13.3 + i / 100, radiusM: 500 });

test('home area first (exit only, ~100 m precision), then events, then saved places (enter only)', () => {
  const r = planRegions(here, [ev(1)], [place(1)]);
  assert.deepEqual(r, [
    { identifier: HOME_ID, latitude: 52.52, longitude: 13.405, radius: 1000, notifyOnEnter: false, notifyOnExit: true },
    { identifier: 'event:e1', latitude: 52.51, longitude: 13.4, radius: 200, notifyOnEnter: true, notifyOnExit: false },
    { identifier: 'place:p1', latitude: 52.4, longitude: 13.31, radius: 500, notifyOnEnter: true, notifyOnExit: false },
  ]);
  assert.equal(planRegions(null, [ev(1)], [])[0].identifier, 'event:e1');
});

test('never more than iOS allows; events win over saved places', () => {
  const r = planRegions(here, Array.from({ length: 15 }, (_, i) => ev(i)), Array.from({ length: 10 }, (_, i) => place(i)));
  assert.equal(r.length, MAX_REGIONS);
  assert.equal(r.filter((x) => x.identifier.startsWith('event:')).length, 15);
  assert.equal(r.filter((x) => x.identifier.startsWith('place:')).length, 4);
});

test('reacting: leaving home re-centres, entering an event or place sends the position, the rest is ignored', () => {
  assert.equal(reactTo(2, HOME_ID), 'recentre');
  assert.equal(reactTo(1, HOME_ID), 'ignore');
  assert.equal(reactTo(1, 'event:x'), 'send');
  assert.equal(reactTo(1, 'place:y'), 'send');
  assert.equal(reactTo(2, 'event:x'), 'ignore');
  assert.equal(reactTo(1, undefined), 'ignore');
});

test('unchanged plans are not re-registered (order does not matter)', () => {
  const a = planRegions(here, [ev(1), ev(2)], []);
  assert.equal(sameRegions(a, [a[0], a[2], a[1]]), true);
  assert.equal(sameRegions(a, planRegions(here, [ev(1)], [])), false);
  assert.equal(sameRegions(a, planRegions({ lat: 52.6, lon: 13.4 }, [ev(1), ev(2)], [])), false);
});
