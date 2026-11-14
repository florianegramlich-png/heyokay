// Offline demo: runs the full API on an in-memory DB, fed from the test fixtures instead of live feeds.
// `npm run demo`, then point the app at it (EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:8787) or open /admin.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApi } from './api.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { GazetteerGeocoder } from './geocode.js';
import { AnthropicLLM } from './llm.js';
import { Pipeline } from './pipeline/run.js';
import { MemoryPushSender } from './push.js';
import { toSourceItem } from './sources/nina.js';
import { parseFeed } from './sources/rss.js';

const fx = (f: string) => readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', f), 'utf8');

// Fixtures describe a Saturday morning in Berlin; pin the pipeline clock there so nothing is "stale".
const FIXTURE_NOW = new Date('2026-11-14T09:50:00+01:00');

const config = { ...loadConfig(), dbPath: ':memory:', pollIntervalSec: 0 };
const store = new Store(':memory:');
const llm = new AnthropicLLM(config.anthropicApiKey, config.model);
const push = new MemoryPushSender();
const pipeline = new Pipeline({ store, llm, geocoder: new GazetteerGeocoder(), push, config, now: () => FIXTURE_NOW });

async function runIngest() {
  const warning = JSON.parse(fx('nina-dwd-warning.json'));
  const geo = JSON.parse(fx('nina-dwd-geo.json'));
  const entry = { id: warning.identifier, version: 1, type: 'Alert' };
  const nina = toSourceItem('dwd', entry, warning, geo);
  return {
    nina: await pipeline.ingest(nina ? [nina] : []),
    police: await pipeline.ingest(parseFeed(fx('police-berlin.rss'), { url: 'fixture', sourceName: 'Polizei Berlin', categoryHint: 'crime' })),
    transit: await pipeline.ingest(parseFeed(fx('transit.rss'), { url: 'fixture', sourceName: 'S-Bahn Berlin', categoryHint: 'transit' })),
  };
}

const app = buildApi({ store, pipeline, adminToken: config.adminToken, runIngest });
await app.listen({ port: config.port, host: '0.0.0.0' });

// A ready-made user standing at Ostkreuz, so the feed has something in it straight away.
const { user, token } = store.createUser(null);
store.updateLocation(user.id, 52.503, 13.469);
const report = await runIngest();

console.log(`\nHey-Okay demo on http://localhost:${config.port}  ·  AI ${llm.enabled ? 'on' : 'off (rules + templates)'}`);
console.log(`Alert Desk:  http://localhost:${config.port}/admin   (admin token: ${config.adminToken})`);
console.log(`Demo user:   curl -H "authorization: Bearer ${token}" localhost:${config.port}/v1/me/alerts`);
console.log('Ingest:', JSON.stringify(report));
console.log('Pushes sent:', push.outbox.map((p) => p.alert.title));
