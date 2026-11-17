import { SqliteStore } from '../src/db.js';
import type { Store } from '../src/store.js';

export interface Backend {
  name: string;
  /** A fresh, empty store. */
  make: () => Promise<Store>;
}

/** Every storage backend the shared test suites run against. */
export function storeBackends(): Backend[] {
  return [{ name: 'sqlite', make: async () => new SqliteStore(':memory:') }];
}
