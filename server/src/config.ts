import { parseProviders, type LlmProviderName } from './llm-providers.js';
import { parseClientIds } from './identity.js';
import { USGS_URL } from './sources/usgs.js';
import { PEGELONLINE_URL } from './sources/pegelonline.js';
import { WFIGS_URL } from './sources/wildfire.js';
import { IPAWS_URL } from './sources/ipaws.js';
import { SACHET_RSS_URL } from './sources/sachet.js';
import { parseStatusPages, type StatusPage } from './sources/statuspage.js';
import type { CountryCode } from './countries.js';
import { parseCountries } from './sources/registry.js';
import { parseRole, type Role } from './roles.js';
import { selectAgencies, type PresseportalAgency } from './sources/presseportal.js';
import { parseDwdMode, type DwdMode } from './sources/dwd.js';

export interface RssFeedConfig {
  url: string;
  sourceName: string;
  /** Category hint for the extractor, e.g. "crime" for police press feeds, "transit" for operator feeds. */
  categoryHint?: 'crime' | 'transit' | 'public_safety' | 'infrastructure' | 'health' | 'weather';
  /** Fallback location if an item names no place the geocoder can resolve. */
  defaultArea?: { name: string; lat: number; lon: number; radiusM: number };
}

export interface Config {
  port: number;
  /** Postgres connection string. When set, it is used instead of the SQLite file. */
  databaseUrl: string | null;
  /** Postgres schema for our tables (e.g. `heyokay` on Supabase, so its public Data API can't see them). */
  databaseSchema: string | null;
  dbPath: string;
  adminToken: string;
  anthropicApiKey: string | null;
  /** Small, fast model for extraction and alert writing. */
  model: string;
  /** AI providers in failover order (`LLM_PROVIDERS`, default `anthropic`); ones without a key are left out. */
  llmProviders: LlmProviderName[];
  mistralApiKey: string | null;
  mistralModel: string;
  mistralUrl: string;
  /** Any OpenAI-style chat API (e.g. an open-weight model on EU hosting). */
  openaiCompatUrl: string | null;
  openaiCompatApiKey: string | null;
  openaiCompatModel: string | null;
  openaiCompatJsonMode: 'schema' | 'object';
  /** NINA channels to poll. https://warnung.bund.de/api31 */
  ninaChannels: string[];
  rssFeeds: RssFeedConfig[];
  /** Berliner Feuerwehr incident reports (FEUERWEHR_BERLIN=off to disable). */
  feuerwehrBerlin: boolean;
  /** Polizei Berlin press releases from berlin.de (POLIZEI_BERLIN=off to disable). */
  polizeiBerlin: boolean;
  /** Email sign-in codes via Resend; both unset = email sign-in off. */
  resendApiKey: string | null;
  /** Sign in with Apple: accepted audiences (iOS bundle id, web Services ID); null = off. */
  appleClientIds: string[] | null;
  /** Sign in with Google: accepted audiences (iOS, Android and web OAuth client ids); null = off. */
  googleClientIds: string[] | null;
  mailFrom: string | null;
  /** OpenWeatherMap key for heat at people's places; unset = off. */
  openWeatherApiKey: string | null;
  /** Felt temperature (°C) from which heat is reported; +3 and +6 raise the level. */
  heatThresholdC: number;
  /** DWD warnings from DWD open data: only while NINA's DWD channel fails (default), always, or off. */
  dwdDirect: DwdMode;
  /** Presseportal Blaulicht agencies to poll (keys from sources/presseportal.ts). Default: all of them. */
  presseportalAgencies: PresseportalAgency[];
  /** US National Weather Service areas to poll: state codes ("CA") or "lat,lon" points. Empty = off. */
  nwsAreas: string[];
  nwsUserAgent: string;
  pollIntervalSec: number;
  /** Nominatim (OpenStreetMap) for geocoding place names from unstructured sources. */
  geocoderUrl: string | null;
  geocoderUserAgent: string;
  expoPushUrl: string;
  /** Expo access token, if "enhanced push security" is turned on for the EAS project. */
  expoAccessToken: string | null;
  /** api: HTTP only · worker: ingest + push only · all: both (default, one machine). */
  role: Role;
  /** USGS earthquake feed (URL override or "off"). */
  usgs: string | null;
  /** PEGELONLINE river gauges, Germany (URL override or "off"). Polled at most every 15 minutes. */
  pegelonline: string | null;
  /** NIFC WFIGS wildfire incidents, US (ArcGIS layer URL override or "off"). Polled at most every 5 minutes. */
  wfigs: string | null;
  /** AI cost guard: daily cap in EUR (0 = off) and prices per million tokens. */
  llmDailyBudgetEur: number;
  llmPriceInPerMTok: number;
  llmPriceOutPerMTok: number;
  /** FEMA IPAWS public feed (US). "off" or a URL override via IPAWS_URL. */
  ipaws: string | null;
  /** NDMA SACHET RSS (India). "off" or a URL override via SACHET_RSS_URL. */
  sachet: string | null;
  /** Status pages polled for technology outages (STATUS_PAGES JSON, or "off"). Default: US list. */
  statusPages: StatusPage[];
  /** Internal Prometheus port (Fly scrapes it; never public). 0 = off. */
  metricsPort: number;
  /** Sentry DSN (EU region) for server errors; unset = stderr only. */
  sentryDsn: string | null;
  /** Countries whose sources run (COUNTRIES=DE,AT). null = all. */
  countries: CountryCode[] | null;
  /** Push sends in flight at once from the delivery queue (each up to 500 pushes). */
  pushConcurrency: number;
  /** This process's name in the worker lease (Fly sets FLY_MACHINE_ID). */
  instanceId: string;
  /** Matching buffer added to an event's radius when deciding who is affected. */
  matchBufferM: number;
  /** Below this extraction confidence, events go to the Alert Desk. */
  reviewConfidence: number;
  /** Non-official events at or above this severity go to the Alert Desk (MVP). */
  reviewSeverity: number;
  /** OpenAI-style embeddings endpoint for dedup (e.g. Mistral, OpenAI, Voyage). All three unset = word overlap only. */
  embeddingsUrl: string | null;
  embeddingsApiKey: string | null;
  embeddingsModel: string | null;
  embeddingsDimensions: number | null;
  /** Cosine similarity at or above which two nearby reports count as the same incident. Model-specific. */
  embeddingsMinSimilarity: number;
}

export function loadConfig(env = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    databaseUrl: env.DATABASE_URL || null,
    databaseSchema: env.DATABASE_SCHEMA || null,
    dbPath: env.DB_PATH ?? './heyokay.db',
    adminToken: env.ADMIN_TOKEN ?? 'change-me',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    model: env.HEYOKAY_MODEL ?? 'claude-haiku-5-5',
    llmProviders: parseProviders(env.LLM_PROVIDERS),
    mistralApiKey: env.MISTRAL_API_KEY || null,
    mistralModel: env.MISTRAL_MODEL ?? 'mistral-small-latest',
    mistralUrl: env.MISTRAL_URL ?? 'https://api.mistral.ai/v1',
    openaiCompatUrl: env.OPENAI_COMPAT_URL || null,
    openaiCompatApiKey: env.OPENAI_COMPAT_API_KEY || null,
    openaiCompatModel: env.OPENAI_COMPAT_MODEL || null,
    openaiCompatJsonMode: env.OPENAI_COMPAT_JSON_MODE === 'object' ? 'object' : 'schema',
    ninaChannels: (env.NINA_CHANNELS ?? 'mowas,katwarn,biwapp,dwd,lhp,police').split(',').map((s) => s.trim()).filter(Boolean),
    rssFeeds: env.RSS_FEEDS ? (JSON.parse(env.RSS_FEEDS) as RssFeedConfig[]) : [],
    presseportalAgencies: selectAgencies(env.PRESSEPORTAL_AGENCIES),
    dwdDirect: parseDwdMode(env.DWD_DIRECT),
    openWeatherApiKey: env.OPENWEATHER_API_KEY || null,
    resendApiKey: env.RESEND_API_KEY || null,
    mailFrom: env.MAIL_FROM || null,
    appleClientIds: parseClientIds(env.APPLE_CLIENT_IDS),
    googleClientIds: parseClientIds(env.GOOGLE_CLIENT_IDS),
    heatThresholdC: Number(env.HEAT_THRESHOLD_C ?? 32),
    feuerwehrBerlin: !/^(off|false|0|no)$/i.test(env.FEUERWEHR_BERLIN ?? 'on'),
    polizeiBerlin: !/^(off|false|0|no)$/i.test(env.POLIZEI_BERLIN ?? 'on'),
    nwsAreas: (env.NWS_AREAS ?? '').split(';').flatMap((a) => (a.includes(',') && /\d/.test(a) ? [a] : a.split(','))).map((s) => s.trim()).filter(Boolean),
    nwsUserAgent: env.NWS_USER_AGENT ?? env.GEOCODER_USER_AGENT ?? 'HeyOkay/0.1 (set NWS_USER_AGENT to your contact)',
    pollIntervalSec: Number(env.POLL_INTERVAL_SEC ?? 120),
    geocoderUrl: env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/search',
    geocoderUserAgent: env.GEOCODER_USER_AGENT ?? 'HeyOkay/0.1 (set GEOCODER_USER_AGENT to your contact)',
    expoPushUrl: env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send',
    expoAccessToken: env.EXPO_ACCESS_TOKEN || null,
    role: parseRole(env.ROLE),
    usgs: /^off$/i.test(env.USGS_URL ?? '') ? null : (env.USGS_URL || USGS_URL),
    wfigs: /^off$/i.test(env.WFIGS_URL ?? '') ? null : (env.WFIGS_URL || WFIGS_URL),
    pegelonline: /^off$/i.test(env.PEGELONLINE_URL ?? '') ? null : (env.PEGELONLINE_URL || PEGELONLINE_URL),
    llmDailyBudgetEur: Number(env.LLM_DAILY_BUDGET_EUR ?? 5),
    llmPriceInPerMTok: Number(env.LLM_PRICE_IN_EUR_PER_MTOK ?? 1),
    llmPriceOutPerMTok: Number(env.LLM_PRICE_OUT_EUR_PER_MTOK ?? 5),
    ipaws: /^off$/i.test(env.IPAWS_URL ?? '') ? null : (env.IPAWS_URL || IPAWS_URL),
    sachet: /^off$/i.test(env.SACHET_RSS_URL ?? '') ? null : (env.SACHET_RSS_URL || SACHET_RSS_URL),
    statusPages: parseStatusPages(env.STATUS_PAGES),
    metricsPort: Number(env.METRICS_PORT ?? 9091),
    sentryDsn: env.SENTRY_DSN || null,
    countries: parseCountries(env.COUNTRIES),
    pushConcurrency: Math.max(1, Number(env.PUSH_CONCURRENCY ?? 4)),
    instanceId: env.FLY_MACHINE_ID || env.HOSTNAME || `local-${process.pid}`,
    matchBufferM: Number(env.MATCH_BUFFER_M ?? 1500),
    reviewConfidence: Number(env.REVIEW_CONFIDENCE ?? 0.6),
    reviewSeverity: Number(env.REVIEW_SEVERITY ?? 4),
    embeddingsUrl: env.EMBEDDINGS_URL || null,
    embeddingsApiKey: env.EMBEDDINGS_API_KEY || null,
    embeddingsModel: env.EMBEDDINGS_MODEL || null,
    embeddingsDimensions: env.EMBEDDINGS_DIMENSIONS ? Number(env.EMBEDDINGS_DIMENSIONS) : null,
    embeddingsMinSimilarity: Number(env.EMBEDDINGS_MIN_SIMILARITY ?? 0.8),
  };
}
