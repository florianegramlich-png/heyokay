import { loadConfig } from './config.js';
import { Store } from './db.js';
import { AnthropicLLM } from './llm.js';
import { NominatimGeocoder, GazetteerGeocoder } from './geocode.js';
import { ExpoPushSender } from './push.js';
import { Pipeline } from './pipeline/run.js';
import { fetchNinaChannel } from './sources/nina.js';
import { fetchFeed } from './sources/rss.js';
import { fetchNwsArea, nwsFetcher } from './sources/nws.js';
import { buildApi } from './api.js';
import { installProcessHandlers, logError } from './errors.js';

installProcessHandlers();

const config = loadConfig();
// A hosted server with the default admin token would let anyone send alerts from the Alert Desk.
if (process.env.NODE_ENV === 'production' && config.adminToken === 'change-me') {
  console.error('Refusing to start: set ADMIN_TOKEN (e.g. `fly secrets set ADMIN_TOKEN=…`).');
  process.exit(1);
}
const store = new Store(config.dbPath);
const llm = new AnthropicLLM(config.anthropicApiKey, config.model);
const geocoder = config.geocoderUrl ? new NominatimGeocoder(config.geocoderUrl, config.geocoderUserAgent) : new GazetteerGeocoder();
const pipeline = new Pipeline({ store, llm, geocoder, push: new ExpoPushSender(config.expoPushUrl), config });

const seen = (source: string) => (externalId: string) =>
  !store.db.prepare('SELECT 1 FROM source_items WHERE source = ? AND external_id = ?').get(source, externalId);

let running = false;
async function runIngest() {
  if (running) return { skipped: 'already running' };
  running = true;
  const report: Record<string, unknown> = {};
  try {
    for (const channel of config.ninaChannels) {
      try {
        report[`nina:${channel}`] = await pipeline.ingest(await fetchNinaChannel(channel, seen('nina')));
      } catch (err) {
        logError('ingest', err, { source: `nina:${channel}` });
        report[`nina:${channel}`] = { error: (err as Error).message };
      }
    }
    for (const feed of config.rssFeeds) {
      try {
        report[`rss:${feed.sourceName}`] = await pipeline.ingest(await fetchFeed(feed), feed.defaultArea);
      } catch (err) {
        logError('ingest', err, { source: `rss:${feed.sourceName}` });
        report[`rss:${feed.sourceName}`] = { error: (err as Error).message };
      }
    }
    const nwsGet = nwsFetcher(config.nwsUserAgent);
    for (const area of config.nwsAreas) {
      try {
        report[`nws:${area}`] = await pipeline.ingest(await fetchNwsArea(area, seen('nws'), nwsGet));
      } catch (err) {
        logError('ingest', err, { source: `nws:${area}` });
        report[`nws:${area}`] = { error: (err as Error).message };
      }
    }
  } finally {
    running = false;
  }
  return report;
}

const app = buildApi({ store, pipeline, adminToken: config.adminToken, runIngest });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hey-Okay server on :${config.port} · AI ${llm.enabled ? `on (${config.model})` : 'off — rules + templates'} · Alert Desk at /admin`);
if (config.adminToken === 'change-me') console.warn('⚠ Set ADMIN_TOKEN before exposing this server.');

if (config.pollIntervalSec > 0) {
  const tick = () => runIngest().then((r) => console.log('[ingest]', JSON.stringify(r))).catch((e) => logError('ingest', e));
  tick();
  setInterval(tick, config.pollIntervalSec * 1000);
}
