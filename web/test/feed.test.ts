import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aheadAlerts, byCategory, currentAlerts } from '../lib/feed';
import type { Alert } from '../lib/types';

let n = 0;
function alert(over: Partial<Alert>): Alert {
  n++;
  return {
    id: `a${n}`, eventId: `e${n}`, title: 'T', body: 'B', action: 'A', category: 'weather', severity: 3,
    official: false, aiWritten: false, sourceName: 'S', sourceUrl: null, lat: 52.5, lon: 13.4, radiusM: 1000,
    matchedPlace: null, delivery: 'feed', reason: '', feedback: null, createdAt: '2026-11-18T10:00:00Z',
    kind: 'new', ended: false, ...over,
  };
}

test('current alerts: newest per event, without ended events or all-clears, most severe first', () => {
  const old = alert({ eventId: 'storm', severity: 3, createdAt: '2026-11-18T08:00:00Z' });
  const update = alert({ eventId: 'storm', severity: 4, kind: 'update', createdAt: '2026-11-18T09:00:00Z' });
  const fire = alert({ eventId: 'fire', category: 'public_safety', severity: 3, createdAt: '2026-11-18T09:30:00Z' });
  const ended = alert({ eventId: 'gone', ended: true });
  const lifted = alert({ eventId: 'lifted', createdAt: '2026-11-18T07:00:00Z' });
  const allClear = alert({ eventId: 'lifted', kind: 'all_clear', createdAt: '2026-11-18T09:45:00Z' });
  const ids = currentAlerts([old, update, fire, ended, lifted, allClear]).map((a) => a.id);
  assert.deepEqual(ids, [update.id, fire.id]);
});

test('grouped by category in the app order, empty categories left out; nothing at all is "Alles okay"', () => {
  const groups = byCategory([
    alert({ category: 'transit' }), alert({ category: 'weather' }), alert({ category: 'transit' }),
  ]);
  assert.deepEqual(groups.map((g) => [g.category, g.alerts.length]), [['weather', 1], ['transit', 2]]);
  assert.deepEqual(byCategory([]), []);
  assert.deepEqual(byCategory([alert({ ended: true })]), []);
});

test('coming up: events that begin more than an hour from now, soonest first, not under Now', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const tomorrow = alert({ startsAt: '2026-11-19T14:00:00Z', category: 'weather' });
  const tonight = alert({ startsAt: '2026-11-18T20:00:00Z', category: 'public_safety' });
  const soon = alert({ startsAt: '2026-11-18T12:30:00Z' }); // within the hour → Now
  const current = alert({});
  const all = [tomorrow, tonight, soon, current];
  assert.deepEqual(aheadAlerts(all, now).map((a) => a.id), [tonight.id, tomorrow.id]);
  const realNow = Date.now;
  Date.now = () => now;
  try {
    assert.deepEqual(currentAlerts(all).map((a) => a.id).sort(), [soon.id, current.id].sort());
  } finally { Date.now = realNow; }
});
