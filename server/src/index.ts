import { loadConfig } from './config.js';
import { createStore, storeKind } from './create-store.js';
import { createLLM } from './llm-providers.js';
import { BudgetedLLM } from './llm-budget.js';
import { NominatimGeocoder, GazetteerGeocoder } from './geocode.js';
import { ExpoPushSender } from './push.js';
import { Pipeline } from './pipeline/run.js';
import { fetchNinaChannel } from './sources/nina.js';
import { fetchFeed } from './sources/rss.js';
import { fetchAgency } from './sources/presseportal.js';
import { fetchDwdSnapshot } from './sources/dwd.js';
import { CELL_DEG, fetchHeat, owmFetcher } from './sources/heat.js';
import { FEUERWEHR_BERLIN_AREA, fetchFeuerwehrBerlin } from './sources/feuerwehr-berlin.js';
import { POLIZEI_BERLIN_AREA, fetchPolizeiBerlin } from './sources/polizei-berlin.js';
import { fetchNwsArea, nwsFetcher } from './sources/nws.js';
import { fetchStatusPage } from './sources/statuspage.js';
import { fetchIpaws } from './sources/ipaws.js';
import { fetchQuakes } from './sources/usgs.js';
import { fetchPegelonline } from './sources/pegelonline.js';
import { fetchRecalls } from './sources/lebensmittelwarnung.js';
import { fetchFdaRecalls, fetchCpscRecalls } from './sources/us-recalls.js';
import { berlinDate, fetchPollenUv, pollenUvDue } from './sources/dwd-health.js';
import { fetchAssemblies } from './sources/berlin-versammlungen.js';
import { fetchAutobahn } from './sources/autobahn.js';
import { californiaUvDue, fetchCaliforniaUv, localDate } from './sources/us-uv.js';
import { fetchWildfires } from './sources/wildfire.js';
import { fetchAir } from './sources/air.js';
import { fetchSachet } from './sources/sachet.js';
import { buildApi } from './api.js';
import { createEmbedder } from './embeddings.js';
import { installProcessHandlers, logError, sentrySink, setErrorSinks, stderrSink } from './errors.js';
import { M, registry } from './metrics.js';
import { sourceHealth } from './sources/registry.js';
import { ResendMailer } from './auth.js';
import { IdentityVerifier } from './identity.js';
import { IngestScheduler, Mutex, type SourceTask } from './ingest.js';
import { describeSource, sourceEnabled } from './sources/registry.js';
import { LeaderElector, leaseTtlMs, runsApi, runsWorker } from './roles.js';
import Fastify from 'fastify';

const config = loadConfig();
if (config.sentryDsn) setErrorSinks(stderrSink, sentrySink(config.sentryDsn, { environment: process.env.NODE_ENV ?? 'development', release: process.env.FLY_IMAGE_REF }));
installProcessHandlers();
// A hosted server with the default admin token would let anyone send alerts from the Alert Desk.
if (process.env.NODE_ENV === 'production' && config.adminToken === 'change-me') {
  console.error('Refusing to start: set ADMIN_TOKEN (e.g. `fly secrets set ADMIN_TOKEN=…`).');
  process.exit(1);
}
const store = await createStore(config);
const providers = createLLM(config);
const llm = new BudgetedLLM(providers, store, {
  dailyBudgetEur: config.llmDailyBudgetEur, priceInPerMTok: config.llmPriceInPerMTok, priceOutPerMTok: config.llmPriceOutPerMTok,
});
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
const airChecked = new Map<string, number>();
// Gauges report every 15 minutes; the full list is ~600 kB, so don't fetch it more often.
const PEGEL_EVERY_MS = 15 * 60_000;
let pegelLast = 0;
// Recalls: a few a day; the feed is ~450 kB.
const RECALLS_EVERY_MS = 30 * 60_000;
let recallsLast = 0;
// US recalls: FDA reports weekly, CPSC a handful a week; openFDA allows 1000 calls a day without a key.
const US_RECALLS_EVERY_MS = 6 * 3600_000;
let fdaLast = 0;
let cpscLast = 0;
// Pollen & UV: once a day, in the morning (Berlin date of the last successful read).
let pollenUvDate: string | null = null;
let caUvDate: string | null = null;
// Berlin assemblies: the export is ~600 kB and changes a few times a day.
const ASSEMBLIES_EVERY_MS = 60 * 60_000;
let assembliesLast = 0;
// Autobahn: ~230 small requests per round, so not more often than every 15 minutes.
const AUTOBAHN_EVERY_MS = 15 * 60_000;
let autobahnLast = 0;
const FIRES_EVERY_MS = 5 * 60_000;
let firesLast = 0;

const tasks: SourceTask[] = [
  // Not a source, but runs on the same clock: delivery receipts for pushes sent 15+ minutes ago.
  { key: 'push:receipts', run: () => ingestLock.run(() => pipeline.checkPushReceipts()) },
  // Leftovers in the delivery queue (a sender that died mid-batch); normally empty.
  { key: 'push:queue', run: () => pipeline.drainPushQueue() },
  // Evening summaries that are due (each person's own time, default 18:00).
  { key: 'push:digest', run: () => ingestLock.run(() => pipeline.sendDigests()) },
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
  ...(config.polizeiBerlin ? [{
    key: 'polizei-berlin',
    run: async () => ingest(await fetchPolizeiBerlin(seen('rss')), POLIZEI_BERLIN_AREA),
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
  ...(config.openWeatherApiKey ? [{
    key: 'owm:air',
    run: async () => {
      const cells = await store.locationCells(CELL_DEG, new Date(Date.now() - 24 * 3600_000).toISOString());
      const r = await fetchAir(cells, seen('owm'), owmFetcher(config.openWeatherApiKey!), { lastChecked: airChecked });
      return { cells: cells.length, checked: r.checked, ...(await ingest(r.items)) };
    },
  }] : []),
  ...(config.usgs ? [{
    key: 'usgs:quakes',
    run: async () => ingest(await fetchQuakes(seen('usgs'), undefined, { url: config.usgs! })),
  }] : []),
  ...(config.pegelonline ? [{
    key: 'pegelonline:DE',
    run: async () => {
      if (Date.now() - pegelLast < PEGEL_EVERY_MS) return { skipped: 'checked less than 15 minutes ago' };
      // Levels that fell back to normal get an all-clear.
      const r = await ingestAndReconcile(await fetchPegelonline(seen('pegelonline'), undefined, { url: config.pegelonline! }));
      pegelLast = Date.now();
      return r;
    },
  }] : []),
  ...(config.lebensmittelwarnung ? [{
    key: 'lebensmittelwarnung:DE',
    run: async () => {
      if (Date.now() - recallsLast < RECALLS_EVERY_MS) return { skipped: 'checked less than 30 minutes ago' };
      const r = await ingest(await fetchRecalls(seen('lebensmittelwarnung'), undefined, { url: config.lebensmittelwarnung! }));
      recallsLast = Date.now();
      return r;
    },
  }] : []),
  ...(config.fdaRecalls ? [{
    key: 'fda:US',
    run: async () => {
      if (Date.now() - fdaLast < US_RECALLS_EVERY_MS) return { skipped: 'checked less than 6 hours ago' };
      const r = await ingest(await fetchFdaRecalls(seen('fda'), undefined, { url: config.fdaRecalls! }));
      fdaLast = Date.now();
      return r;
    },
  }] : []),
  ...(config.cpscRecalls ? [{
    key: 'cpsc:US',
    run: async () => {
      if (Date.now() - cpscLast < US_RECALLS_EVERY_MS) return { skipped: 'checked less than 6 hours ago' };
      const r = await ingest(await fetchCpscRecalls(seen('cpsc'), undefined, { url: config.cpscRecalls! }));
      cpscLast = Date.now();
      return r;
    },
  }] : []),
  ...(config.autobahn ? [{
    key: 'autobahn:DE',
    run: async () => {
      if (Date.now() - autobahnLast < AUTOBAHN_EVERY_MS) return { skipped: 'checked less than 15 minutes ago' };
      // Closures that leave the list early get an all-clear.
      const r = await ingestAndReconcile(await fetchAutobahn(seen('autobahn'), undefined, { url: config.autobahn! }));
      autobahnLast = Date.now();
      return r;
    },
  }] : []),
  ...(config.berlinVersammlungen ? [{
    key: 'berlin-versammlungen:DE',
    run: async () => {
      if (Date.now() - assembliesLast < ASSEMBLIES_EVERY_MS) return { skipped: 'checked less than an hour ago' };
      const r = await ingest(await fetchAssemblies(seen('berlin-versammlungen'), undefined, { url: config.berlinVersammlungen!, geocoder }));
      assembliesLast = Date.now();
      return r;
    },
  }] : []),
  ...(config.epaUv ? [{
    key: 'epa-uv:US',
    run: async () => {
      const now = new Date();
      if (!californiaUvDue(now, caUvDate)) return { skipped: 'read once a day after 07:05 California time' };
      const r = await ingest(await fetchCaliforniaUv(seen('epa-uv'), undefined, { url: config.epaUv!, now }));
      caUvDate = localDate(now, 'America/Los_Angeles');
      return r;
    },
  }] : []),
  ...(config.dwdHealth ? [{
    key: 'dwd-health:DE',
    run: async () => {
      const now = new Date();
      if (!pollenUvDue(now, pollenUvDate)) return { skipped: 'read once a day after 07:05' };
      const r = await ingest(await fetchPollenUv(seen('dwd-health'), undefined, { url: config.dwdHealth!, now }));
      pollenUvDate = berlinDate(now);
      return r;
    },
  }] : []),
  ...(config.wfigs ? [{
    key: 'wfigs:US',
    run: async () => {
      if (Date.now() - firesLast < FIRES_EVERY_MS) return { skipped: 'checked less than 5 minutes ago' };
      // Fires that are out, contained or no longer reported get an all-clear.
      const r = await ingestAndReconcile(await fetchWildfires(seen('wfigs'), undefined, { url: config.wfigs! }));
      firesLast = Date.now();
      return r;
    },
  }] : []),
  ...(config.ipaws ? [{
    key: 'ipaws:US',
    run: async () => ingest(await fetchIpaws(seen('ipaws'), undefined, { url: config.ipaws! })),
  }] : []),
  ...(config.sachet ? [{
    key: 'sachet:IN',
    // Withdrawn alerts leave the RSS: they get an all-clear.
    run: async () => ingestAndReconcile(await fetchSachet(seen('sachet'), undefined, { url: config.sachet! })),
  }] : []),
  ...config.statusPages.map((page) => ({
    key: `statuspage:${page.key}`,
    // Resolved incidents leave the list: their alerts get an all-clear.
    run: async () => ingestAndReconcile(await fetchStatusPage(page, seen('statuspage'))),
  })),
  ...config.nwsAreas.map((area) => ({
    key: `nws:${area}`,
    // Only after a successful poll: alerts that vanished early get an all-clear.
    run: async () => ingestAndReconcile(await fetchNwsArea(area, seen('nws'), nwsFetcher(config.nwsUserAgent))),
  })),
];

// Only sources of the configured countries (COUNTRIES); system tasks and place-following sources always.
const enabledTasks = tasks.filter((t) => sourceEnabled(describeSource(t.key), config.countries));
const scheduler = new IngestScheduler(enabledTasks, (key, err) => logError('ingest', err, { source: key }));
const worker = runsWorker(config.role);
const leader = new LeaderElector(store, config.instanceId, leaseTtlMs(config.pollIntervalSec), undefined, (leading) =>
  console.log(`[worker] ${config.instanceId} ${leading ? 'took over ingest and push' : 'stood down'}`));
// Work only while holding the worker lease, so two machines never fetch or push the same thing.
const runIngest = async () => {
  if (!worker) return { skipped: 'this machine serves the API only (ROLE=api); the worker polls' };
  if (!(await leader.check())) return { skipped: 'another worker holds the lease' };
  const report = await scheduler.tick();
  // Shared with the API machines (Alert Desk → Sources), whichever machine they are.
  await store.saveSourceStatuses(scheduler.snapshot()).catch((e) => logError('ingest', e, { step: 'source-status' }));
  return report;
};
const roleStatus = async () => ({
  role: config.role,
  ...(worker ? { worker: leader.status(), pushQueue: await store.pushQueueDepth().catch(() => null) } : {}),
});

const mailer = config.resendApiKey && config.mailFrom ? new ResendMailer(config.resendApiKey, config.mailFrom) : null;
const identity = {
  ...(config.appleClientIds ? { apple: new IdentityVerifier('apple', { audiences: config.appleClientIds }) } : {}),
  ...(config.googleClientIds ? { google: new IdentityVerifier('google', { audiences: config.googleClientIds }) } : {}),
};
let app;
if (runsApi(config.role)) {
  app = buildApi({ store, pipeline, adminToken: config.adminToken, runIngest, ingestStatus: worker ? () => scheduler.snapshot() : undefined, roleStatus, mailer, identity, statusPages: config.statusPages, pollIntervalSec: config.pollIntervalSec, aiBudgetEur: config.llmDailyBudgetEur });
} else {
  // Worker only: no public routes, just the health check the platform polls.
  app = Fastify({ logger: false });
  app.get('/health', async () => ({ ok: true, ...(await roleStatus()), sources: scheduler.snapshot() }));
}
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hey-Okay server on :${config.port} · role ${config.role} · ${storeKind(config)} · AI ${llm.enabled ? `on (${providers.names.join(' → ')})` : 'off — rules + templates'} · dedup ${embedder.enabled ? `embeddings (${embedder.model})` : 'word overlap'}${runsApi(config.role) ? ' · Alert Desk at /admin' : ''}`);
if (config.adminToken === 'change-me') console.warn('⚠ Set ADMIN_TOKEN before exposing this server.');
if (config.role !== 'all' && !config.databaseUrl) console.warn('⚠ Separate api/worker roles need a shared database (DATABASE_URL); SQLite is one machine only.');

// Prometheus on an internal port only (fly.toml [metrics]); gauges are read fresh on each scrape.
if (worker) {
  registry.onCollect(async () => {
    M.workerLeading.set({}, leader.status().leading ? 1 : 0);
    M.pushQueue.set({}, await store.pushQueueDepth());
    M.sourceUp.reset(); M.sourceLastOkAge.reset();
    for (const [key, s] of Object.entries(scheduler.snapshot())) {
      M.sourceUp.set({ source: key }, sourceHealth(s, config.pollIntervalSec) === 'ok' ? 1 : 0);
      if (s.lastOkAt) M.sourceLastOkAge.set({ source: key }, Math.round((Date.now() - Date.parse(s.lastOkAt)) / 1000));
    }
  });
}
if (config.metricsPort > 0) {
  const metricsApp = Fastify({ logger: false });
  metricsApp.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(await registry.render()));
  // Fly scrapes over its private IPv6 network; fall back to IPv4 where there is no IPv6 (local).
  // A metrics port that can't open is logged, never fatal: alerts matter more than charts.
  await metricsApp.listen({ port: config.metricsPort, host: '::' })
    .catch(() => metricsApp.listen({ port: config.metricsPort, host: '0.0.0.0' }))
    .catch((e) => logError('metrics', e, { port: config.metricsPort }));
}

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
