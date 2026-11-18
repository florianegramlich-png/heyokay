import { loadConfig } from './config.js';
import { createStore, storeKind } from './create-store.js';
import { AnthropicLLM } from './llm.js';
import { NominatimGeocoder, GazetteerGeocoder } from './geocode.js';
import { ExpoPushSender } from './push.js';
import { Pipeline } from './pipeline/run.js';
import { fetchNinaChannel } from './sources/nina.js';
import { fetchFeed } from './sources/rss.js';
import { fetchAgency } from './sources/presseportal.js';
import { fetchDwdSnapshot } from './sources/dwd.js';
import { FEUERWEHR_BERLIN_AREA, fetchFeuerwehrBerlin } from './sources/feuerwehr-berlin.js';
import { fetchNwsArea, nwsFetcher } from './sources/nws.js';
import { buildApi } from './api.js';
import { createEmbedder } from './embeddings.js';
import { installProcessHandlers, logError } from './errors.js';

installProcessHandlers();

const config = loadConfig();
// A hosted server with the default admin token would let anyone send alerts from the Alert Desk.
if (process.env.NODE_ENV === 'production' && config.adminToken === 'change-me') {
  console.error('Refusing to start: set ADMIN_TOKEN (e.g. `fly secrets set ADMIN_TOKEN=…`).');
  process.exit(1);
}
const store = await createStore(config);
const llm = new AnthropicLLM(config.anthropicApiKey, config.model);
const geocoder = config.geocoderUrl ? new NominatimGeocoder(config.geocoderUrl, config.geocoderUserAgent) : new GazetteerGeocoder();
const embedder = createEmbedder(config);
const pipeline = new Pipeline({ store, llm, geocoder, embedder, push: new ExpoPushSender(config.expoPushUrl), config });

const seen = (source: string) => async (externalId: string) => !(await store.hasSourceItem(source, externalId));

let running = false;
async function runIngest() {
  if (running) return { skipped: 'already running' };
  running = true;
  const report: Record<string, unknown> = {};
  try {
    let ninaDwdOk = false;
    for (const channel of config.ninaChannels) {
      try {
        report[`nina:${channel}`] = await pipeline.ingest(await fetchNinaChannel(channel, seen('nina')));
        if (channel === 'dwd') ninaDwdOk = true;
      } catch (err) {
        logError('ingest', err, { source: `nina:${channel}` });
        report[`nina:${channel}`] = { error: (err as Error).message };
      }
    }
    // DWD open data: a fallback while NINA's copy of the DWD warnings is unavailable.
    if (config.dwdDirect === 'always' || (config.dwdDirect === 'fallback' && !ninaDwdOk)) {
      try {
        const { feedKey, items, listedIds } = await fetchDwdSnapshot(seen('dwd'));
        const ingested = await pipeline.ingest(items);
        report['dwd:direct'] = { ...ingested, liftedEarly: await pipeline.reconcileFeed(feedKey, listedIds) };
      } catch (err) {
        logError('ingest', err, { source: 'dwd:direct' });
        report['dwd:direct'] = { error: (err as Error).message };
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
    for (const agency of config.presseportalAgencies) {
      try {
        report[`presseportal:${agency.key}`] = await pipeline.ingest(await fetchAgency(agency, seen('presseportal')), agency.area);
      } catch (err) {
        logError('ingest', err, { source: `presseportal:${agency.key}` });
        report[`presseportal:${agency.key}`] = { error: (err as Error).message };
      }
    }
    if (config.feuerwehrBerlin) {
      try {
        report['feuerwehr-berlin'] = await pipeline.ingest(await fetchFeuerwehrBerlin(seen('rss')), FEUERWEHR_BERLIN_AREA);
      } catch (err) {
        logError('ingest', err, { source: 'feuerwehr-berlin' });
        report['feuerwehr-berlin'] = { error: (err as Error).message };
      }
    }
    const nwsGet = nwsFetcher(config.nwsUserAgent);
    for (const area of config.nwsAreas) {
      try {
        const { feedKey, items, listedIds } = await fetchNwsArea(area, seen('nws'), nwsGet);
        const ingested = await pipeline.ingest(items);
        // Only after a successful poll: alerts that vanished early get an all-clear.
        report[`nws:${area}`] = { ...ingested, liftedEarly: await pipeline.reconcileFeed(feedKey, listedIds) };
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
console.log(`Hey-Okay server on :${config.port} · ${storeKind(config)} · AI ${llm.enabled ? `on (${config.model})` : 'off — rules + templates'} · dedup ${embedder.enabled ? `embeddings (${embedder.model})` : 'word overlap'} · Alert Desk at /admin`);
if (config.adminToken === 'change-me') console.warn('⚠ Set ADMIN_TOKEN before exposing this server.');

if (config.pollIntervalSec > 0) {
  const tick = () => runIngest().then((r) => console.log('[ingest]', JSON.stringify(r))).catch((e) => logError('ingest', e));
  tick();
  setInterval(tick, config.pollIntervalSec * 1000);
}
