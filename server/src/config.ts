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
  /** NINA channels to poll. https://warnung.bund.de/api31 */
  ninaChannels: string[];
  rssFeeds: RssFeedConfig[];
  /** Berliner Feuerwehr incident reports (FEUERWEHR_BERLIN=off to disable). */
  feuerwehrBerlin: boolean;
  /** Email sign-in codes via Resend; both unset = email sign-in off. */
  resendApiKey: string | null;
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
    ninaChannels: (env.NINA_CHANNELS ?? 'mowas,katwarn,biwapp,dwd,lhp,police').split(',').map((s) => s.trim()).filter(Boolean),
    rssFeeds: env.RSS_FEEDS ? (JSON.parse(env.RSS_FEEDS) as RssFeedConfig[]) : [],
    presseportalAgencies: selectAgencies(env.PRESSEPORTAL_AGENCIES),
    dwdDirect: parseDwdMode(env.DWD_DIRECT),
    openWeatherApiKey: env.OPENWEATHER_API_KEY || null,
    resendApiKey: env.RESEND_API_KEY || null,
    mailFrom: env.MAIL_FROM || null,
    heatThresholdC: Number(env.HEAT_THRESHOLD_C ?? 32),
    feuerwehrBerlin: !/^(off|false|0|no)$/i.test(env.FEUERWEHR_BERLIN ?? 'on'),
    nwsAreas: (env.NWS_AREAS ?? '').split(';').flatMap((a) => (a.includes(',') && /\d/.test(a) ? [a] : a.split(','))).map((s) => s.trim()).filter(Boolean),
    nwsUserAgent: env.NWS_USER_AGENT ?? env.GEOCODER_USER_AGENT ?? 'HeyOkay/0.1 (set NWS_USER_AGENT to your contact)',
    pollIntervalSec: Number(env.POLL_INTERVAL_SEC ?? 120),
    geocoderUrl: env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/search',
    geocoderUserAgent: env.GEOCODER_USER_AGENT ?? 'HeyOkay/0.1 (set GEOCODER_USER_AGENT to your contact)',
    expoPushUrl: env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send',
    expoAccessToken: env.EXPO_ACCESS_TOKEN || null,
    role: parseRole(env.ROLE),
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
