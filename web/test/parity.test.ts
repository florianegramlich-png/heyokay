import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, statusFor } from '../lib/dashboard';
import { followsService, toggleService } from '../lib/services';
import { groupByDay } from '../lib/history';
import { createApi } from '../lib/api';
import { APP_STRINGS } from '../lib/app-strings';
import type { Alert } from '../lib/types';

// Features the phone app has, now on the web too (2026-11-20): overview, service picker, history search.
let n = 0;
function alert(over: Partial<Alert>): Alert {
  n++;
  return {
    id: `a${n}`, eventId: `e${n}`, title: 'T', body: 'B', action: 'A', category: 'weather', severity: 3,
    official: false, aiWritten: false, sourceName: 'S', sourceUrl: null, lat: 52.5, lon: 13.4, radiusM: 1000,
    matchedPlace: null, delivery: 'feed', reason: '', feedback: null, createdAt: '2026-11-20T10:00:00Z',
    kind: 'new', ended: false, ...over,
  };
}

test('overview: status from the highest current alert; tiles for followed topics; police shows no level', () => {
  const now = Date.now(); // "coming up" is judged against the real clock (lib/feed.ts)
  assert.equal(buildDashboard([], ['weather'], now).status, 'calm');
  const d = buildDashboard([
    alert({ severity: 4 }), alert({ category: 'crime', severity: 3 }),
    alert({ category: 'technology', severity: 1, startsAt: new Date(now + 8 * 3600_000).toISOString() }),
  ], ['weather', 'transit'], now);
  assert.equal(d.status, 'act');
  assert.equal(d.current, 2);
  assert.deepEqual(d.tiles.map((t) => t.category), ['weather', 'crime', 'transit']);
  assert.equal(d.tiles.find((t) => t.category === 'crime')!.highest, null);
  assert.equal(d.next24.length, 1);
  assert.ok(Math.abs(d.next24[0].at - 8 / 24) < 1e-9);
  assert.deepEqual([null, 1, 2, 3, 5].map((s) => statusFor(s as never)), ['calm', 'info', 'info', 'watch', 'act']);
});

test('service picker: from "all" the first tap means only that one; unpicking the last goes back to all', () => {
  assert.deepEqual(toggleService(null, 'zoom'), ['zoom']);
  assert.deepEqual(toggleService(['zoom'], 'chime'), ['zoom', 'chime']);
  assert.equal(toggleService(['zoom'], 'zoom'), null);
  assert.equal(followsService(undefined, 'x'), true);
  assert.equal(followsService(['a'], 'x'), false);
});

test('history: grouped by local day, newest first; the API sends the search and topic', async () => {
  const now = new Date(2026, 10, 20, 15);
  const g = groupByDay([
    alert({ createdAt: new Date(2026, 10, 20, 9).toISOString() }),
    alert({ createdAt: new Date(2026, 10, 19, 9).toISOString() }),
    alert({ createdAt: new Date(2026, 10, 16, 9).toISOString() }),
  ], now);
  assert.deepEqual(g.map((x) => x.label), ['today', 'yesterday', 'date']);
  const calls: string[] = [];
  const f = (async (url: string) => { calls.push(url); return new Response('{"alerts":[],"services":[]}', { status: 200 }); }) as unknown as typeof fetch;
  const api = createApi(f, () => 'tok', 'https://srv.test');
  await api.history({ q: 'S-Bahn Straße', category: 'transit' });
  await api.history();
  await api.services();
  assert.deepEqual(calls, [
    'https://srv.test/v1/me/history?q=S-Bahn+Stra%C3%9Fe&category=transit',
    'https://srv.test/v1/me/history',
    'https://srv.test/v1/services',
  ]);
});

test('the new strings exist in every language', () => {
  for (const lang of ['de', 'en', 'ta'] as const) {
    for (const k of ['dash.status.calm', 'dash.nowMark', 'set.services', 'history.search'] as const) {
      assert.ok(APP_STRINGS[lang][k], `${lang} ${k}`);
    }
  }
});
