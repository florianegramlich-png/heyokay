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
  dbPath: string;
  adminToken: string;
  anthropicApiKey: string | null;
  /** Small, fast model for extraction and alert writing. */
  model: string;
  /** NINA channels to poll. https://warnung.bund.de/api31 */
  ninaChannels: string[];
  rssFeeds: RssFeedConfig[];
  pollIntervalSec: number;
  /** Nominatim (OpenStreetMap) for geocoding place names from unstructured sources. */
  geocoderUrl: string | null;
  geocoderUserAgent: string;
  expoPushUrl: string;
  /** Matching buffer added to an event's radius when deciding who is affected. */
  matchBufferM: number;
  /** Below this extraction confidence, events go to the Alert Desk. */
  reviewConfidence: number;
  /** Non-official events at or above this severity go to the Alert Desk (MVP). */
  reviewSeverity: number;
}

export function loadConfig(env = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    dbPath: env.DB_PATH ?? './heyokay.db',
    adminToken: env.ADMIN_TOKEN ?? 'change-me',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    model: env.HEYOKAY_MODEL ?? 'claude-haiku-5-5',
    ninaChannels: (env.NINA_CHANNELS ?? 'mowas,katwarn,biwapp,dwd,lhp,police').split(',').map((s) => s.trim()).filter(Boolean),
    rssFeeds: env.RSS_FEEDS ? (JSON.parse(env.RSS_FEEDS) as RssFeedConfig[]) : [],
    pollIntervalSec: Number(env.POLL_INTERVAL_SEC ?? 120),
    geocoderUrl: env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/search',
    geocoderUserAgent: env.GEOCODER_USER_AGENT ?? 'HeyOkay/0.1 (set GEOCODER_USER_AGENT to your contact)',
    expoPushUrl: env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send',
    matchBufferM: Number(env.MATCH_BUFFER_M ?? 1500),
    reviewConfidence: Number(env.REVIEW_CONFIDENCE ?? 0.6),
    reviewSeverity: Number(env.REVIEW_SEVERITY ?? 4),
  };
}
