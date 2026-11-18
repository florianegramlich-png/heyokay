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
import { CELL_DEG, fetchHeat, owmFetcher } from './sources/heat.js';
import { FEUERWEHR_BERLIN_AREA, fetchFeuerwehrBerlin } from './sources/feuerwehr-berlin.js';
import { fetchNwsArea, nwsFetcher } from './sources/nws.js';
import { buildApi } from './api.js';
import { createEmbedder } from './embeddings.js';
import { installProcessHandlers, logError } from './errors.js';
import { IngestScheduler, Mutex, type SourceTask } from './ingest.js';

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
const pipeline = new Pipeline({ store, llm, geocoder, embedder, push: new ExpoPushSender(config.expoPushUrl, { accessToken: config.expoAccessToken }), config });

const seen = (source: string) => async (externalId: string) => !(await store.hasSourceItem(source, externalId));

// Pipeline steps one at a time (clustering reads and writes the store); fetching runs in parallel.
const ingestLock = new Mutex();
const ingest = (items: Parameters<typeof pipeline.ingest>[0], area?: Parameters<typeof pipeline.ingest>[1]) =>
  ingestLock.run(() => pipeline.ingest(items, area));
const ingestAndReconcile = (r: { feedKey: string; items: Parameters<typeof pipeline.ingest>[0]; listedIds: Set<string> }) =>
  ingestLock.run(async () => ({ ...(await pipeline.ingest(r.items)), liftedEarly: await pipeline.reconcileFeed(r.feedKey, r.listedIds) }));

/** DWD direct is the fallback while NINA's DWD channel is failing (it has failed and not worked for 10 minutes). */
const NINA_DWD_STALE_MS = 10 * 60_000;
function ninaDwdFailing(): boolean {
  if (!config.ninaChannels.includes('dwd')) return true;
  const s = scheduler.snapshot()['nina:dwd'];
  if (!s?.lastErrorAt) return false; // working, or no result yet
  return !s.lastOkAt || Date.now() - Date.parse(s.lastOkAt) > NINA_DWD_STALE_MS;
}

const heatChecked = new Map<string, number>();

const tasks: SourceTask[] = [
  // Not a source, but runs on the same clock: delivery receipts for pushes sent 15+ minutes ago.
  { key: 'push:receipts', run: () => ingestLock.run(() => pipeline.checkPushReceipts()) },
  ...config.ninaChannels.map((channel) => ({
    key: `nina:${channel}`,
    run: async () => ingest(await fetchNinaChannel(channel, seen('nina'))),
  })),
  ...(config.dwdDirect === 'off' ? [] : [{
    key: 'dwd:direct',
    run: async () => {
      if (config.dwdDirect === 'fallback' && !ninaDwdFailing()) return { skipped: 'NINA DWD channel is working' };
      return ingestAndReconcile(await fetchDwdSnapshot(seen('dwd')));
    },
  }]),
  ...config.rssFeeds.map((feed) => ({
    key: `rss:${feed.sourceName}`,
    run: async () => ingest(await fetchFeed(feed), feed.defaultArea),
  })),
  ...config.presseportalAgencies.map((agency) => ({
    key: `presseportal:${agency.key}`,
    run: async () => ingest(await fetchAgency(agency, seen('presseportal')), agency.area),
  })),
  ...(config.feuerwehrBerlin ? [{
    key: 'feuerwehr-berlin',
    run: async () => ingest(await fetchFeuerwehrBerlin(seen('rss')), FEUERWEHR_BERLIN_AREA),
  }] : []),
  ...(config.openWeatherApiKey ? [{
    key: 'owm:heat',
    run: async () => {
      // Cells with a saved place or a location from the last 24 hours; each cell at most every 3 hours.
      const cells = await store.locationCells(CELL_DEG, new Date(Date.now() - 24 * 3600_000).toISOString());
      const r = await fetchHeat(cells, seen('owm'), owmFetcher(config.openWeatherApiKey!), { thresholdC: config.heatThresholdC, lastChecked: heatChecked });
      return { cells: cells.length, checked: r.checked, ...(await ingest(r.items)) };
    },
  }] : []),
  ...config.nwsAreas.map((area) => ({
    key: `nws:${area}`,
    // Only after a successful poll: alerts that vanished early get an all-clear.
    run: async () => ingestAndReconcile(await fetchNwsArea(area, seen('nws'), nwsFetcher(config.nwsUserAgent))),
  })),
];

const scheduler = new IngestScheduler(tasks, (key, err) => logError('ingest', err, { source: key }));
const runIngest = () => scheduler.tick();

const app = buildApi({ store, pipeline, adminToken: config.adminToken, runIngest, ingestStatus: () => scheduler.snapshot() });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hey-Okay server on :${config.port} · ${storeKind(config)} · AI ${llm.enabled ? `on (${config.model})` : 'off — rules + templates'} · dedup ${embedder.enabled ? `embeddings (${embedder.model})` : 'word overlap'} · Alert Desk at /admin`);
if (config.adminToken === 'change-me') console.warn('⚠ Set ADMIN_TOKEN before exposing this server.');

if (config.pollIntervalSec > 0) {
  const tick = () => runIngest().then((r) => console.log('[ingest]', JSON.stringify(r))).catch((e) => logError('ingest', e));
  tick();
  setInterval(tick, config.pollIntervalSec * 1000);
}
