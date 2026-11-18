import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SqliteStore } from '../src/db.js';
import { Pipeline } from '../src/pipeline/run.js';
import { NoLLM } from '../src/llm.js';
import { GazetteerGeocoder } from '../src/geocode.js';
import { MemoryPushSender } from '../src/push.js';
import { ipawsItems } from '../src/sources/ipaws.js';
import { isAhead } from '../src/pipeline/rank.js';

const IPAWS = readFileSync(new URL('./fixtures/ipaws-recent.xml', import.meta.url), 'utf8');
const NOW = new Date('2026-11-19T02:30:00Z');
const cfg = { matchBufferM: 1500, reviewConfidence: 0.6, reviewSeverity: 4 };

/** The Carmel Valley evacuation warning, but announced for tomorrow afternoon (CAP onset). */
const future = IPAWS.replace('<expires>2026-11-19T06:00:00-08:00</expires>', '<onset>2026-11-19T14:00:00-08:00</onset><expires>2026-11-19T20:00:00-08:00</expires>');

describe('risk outlook ("coming up")', () => {
  it('ahead = begins more than an hour from now', () => {
    expect(isAhead({ onsetAt: '2026-11-19T04:00:00Z' }, NOW)).toBe(true);
    expect(isAhead({ onsetAt: '2026-11-19T03:00:00Z' }, NOW)).toBe(false);
    expect(isAhead({}, NOW)).toBe(false);
  });

  it('a warning that starts tomorrow goes to the feed with its start time, no push; the actual warning then pushes', async () => {
    const store = new SqliteStore();
    const push = new MemoryPushSender();
    const pipeline = new Pipeline({ store, llm: new NoLLM(), geocoder: new GazetteerGeocoder(), push, config: cfg, now: () => NOW });
    const { user } = await store.createUser('ExponentPushToken[x]', { language: 'en', quietHours: null, timezone: 'America/Los_Angeles' });
    await store.updateLocation(user.id, 36.48, -121.75);

    const [item] = ipawsItems(future, NOW);
    expect(item.onsetAt).toBe('2026-11-19T22:00:00.000Z');
    await pipeline.ingest([item]);
    const [a] = await store.alertsForUser(user.id);
    expect(a).toMatchObject({ delivery: 'feed', reason: 'coming up', startsAt: '2026-11-19T22:00:00.000Z', severity: 4 });
    expect(push.outbox).toHaveLength(0);

    // The authority sends the update "now in effect" (no future onset): a real alert with a push.
    const now = { ...item, externalId: 'CA-MontereyCounty-2026-11-18-0002', references: [item.externalId], onsetAt: undefined, officialSeverity: 5 as const };
    await pipeline.ingest([now]);
    const alerts = await store.alertsForUser(user.id);
    expect(alerts.find((x) => x.severity === 5)).toMatchObject({ delivery: 'push' });
    expect(alerts.find((x) => x.severity === 5)?.startsAt).toBeUndefined();
    expect(push.outbox).toHaveLength(1);
    await store.close();
  });
});
