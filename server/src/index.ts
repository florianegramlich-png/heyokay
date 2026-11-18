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
import { ResendMailer } from './auth.js';
import { IngestScheduler, Mutex, type SourceTask } from './ingest.js';
import { LeaderElector, leaseTtlMs, runsApi, runsWorker } from './roles.js';
import Fastify from 'fastify';

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
const pipeline = new Pipeline({ store, llm, geocoder, embedder, push: new ExpoPushSender(config.expoPushUrl, { accessToken: config.expoAccessToken }), config,
  delivery: { holder: config.instanceId, concurrency: config.pushConcurrency } });

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
  // Leftovers in the delivery queue (a sender that died mid-batch); normally empty.
  { key: 'push:queue', run: () => pipeline.drainPushQueue() },
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
const worker = runsWorker(config.role);
const leader = new LeaderElector(store, config.instanceId, leaseTtlMs(config.pollIntervalSec), undefined, (leading) =>
  console.log(`[worker] ${config.instanceId} ${leading ? 'took over ingest and push' : 'stood down'}`));
// Work only while holding the worker lease, so two machines never fetch or push the same thing.
const runIngest = async () => {
  if (!worker) return { skipped: 'this machine serves the API only (ROLE=api); the worker polls' };
  if (!(await leader.check())) return { skipped: 'another worker holds the lease' };
  return scheduler.tick();
};
const roleStatus = async () => ({
  role: config.role,
  ...(worker ? { worker: leader.status(), pushQueue: await store.pushQueueDepth().catch(() => null) } : {}),
});

const mailer = config.resendApiKey && config.mailFrom ? new ResendMailer(config.resendApiKey, config.mailFrom) : null;
let app;
if (runsApi(config.role)) {
  app = buildApi({ store, pipeline, adminToken: config.adminToken, runIngest, ingestStatus: worker ? () => scheduler.snapshot() : undefined, roleStatus, mailer });
} else {
  // Worker only: no public routes, just the health check the platform polls.
  app = Fastify({ logger: false });
  app.get('/health', async () => ({ ok: true, ...(await roleStatus()), sources: scheduler.snapshot() }));
}
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hey-Okay server on :${config.port} · role ${config.role} · ${storeKind(config)} · AI ${llm.enabled ? `on (${config.model})` : 'off — rules + templates'} · dedup ${embedder.enabled ? `embeddings (${embedder.model})` : 'word overlap'}${runsApi(config.role) ? ' · Alert Desk at /admin' : ''}`);
if (config.adminToken === 'change-me') console.warn('⚠ Set ADMIN_TOKEN before exposing this server.');
if (config.role !== 'all' && !config.databaseUrl) console.warn('⚠ Separate api/worker roles need a shared database (DATABASE_URL); SQLite is one machine only.');

if (worker && config.pollIntervalSec > 0) {
  const tick = () => runIngest().then((r) => console.log('[ingest]', JSON.stringify(r))).catch((e) => logError('ingest', e));
  tick();
  setInterval(tick, config.pollIntervalSec * 1000);
}

// Hand the lease over at once on a clean stop (deploys), instead of waiting for it to run out.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    await leader.release();
    await app.close().catch(() => {});
    await store.close().catch(() => {});
    process.exit(0);
  });
}
