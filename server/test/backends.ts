import { randomBytes } from 'node:crypto';
import { SqliteStore } from '../src/db.js';
import { PgStore } from '../src/pg.js';
import type { Store } from '../src/store.js';

export interface Backend {
  name: string;
  /** A fresh, empty store. */
  make: () => Promise<Store>;
}

/**
 * Every storage backend the shared test suites run against. SQLite always; Postgres when
 * TEST_DATABASE_URL is set (CI sets it). Each Postgres store gets its own throwaway schema.
 */
export function storeBackends(): Backend[] {
  const backends: Backend[] = [{ name: 'sqlite', make: async () => new SqliteStore(':memory:') }];
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    backends.push({
      name: 'postgres',
      make: () => PgStore.connect(url, { schema: `t_${randomBytes(6).toString('hex')}`, dropSchemaOnClose: true, max: 4 }),
    });
  }
  return backends;
}
