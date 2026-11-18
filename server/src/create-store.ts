import { SqliteStore } from './db.js';
import { PgStore } from './pg.js';
import type { Store } from './store.js';

/** Postgres when DATABASE_URL is set; otherwise the SQLite file at DB_PATH. */
export async function createStore(config: { databaseUrl: string | null; databaseSchema?: string | null; dbPath: string }): Promise<Store> {
  return config.databaseUrl
    ? PgStore.connect(config.databaseUrl, config.databaseSchema ? { schema: config.databaseSchema } : {})
    : new SqliteStore(config.dbPath);
}

/** For log lines: which backend, never the connection string (it holds the password). */
export function storeKind(config: { databaseUrl: string | null }): string {
  return config.databaseUrl ? 'Postgres' : 'SQLite';
}
