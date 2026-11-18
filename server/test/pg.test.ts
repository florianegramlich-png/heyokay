import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { MIGRATIONS, PgStore } from '../src/pg.js';
import { createStore } from '../src/create-store.js';
import { SqliteStore } from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;

describe('createStore', () => {
  it('uses SQLite without DATABASE_URL', async () => {
    const store = await createStore({ databaseUrl: null, dbPath: ':memory:' });
    expect(store).toBeInstanceOf(SqliteStore);
    await store.close();
  });
});

describe.skipIf(!url)('PgStore (needs TEST_DATABASE_URL)', () => {
  it('applies migrations once and is safe to start again', async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const first = await PgStore.connect(url!, { schema });
    const { user } = await first.createUser(null);
    await first.close();

    const second = await PgStore.connect(url!, { schema, dropSchemaOnClose: true });
    const { rows } = await second.pool.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect((await second.getUser(user.id))?.id).toBe(user.id); // data survived the restart
    await second.close();
  });

  it('migrates concurrently started instances without conflict', async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const stores = await Promise.all([1, 2, 3].map(() => PgStore.connect(url!, { schema, max: 2 })));
    const { rows } = await stores[0].pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect(rows[0].n).toBe(MIGRATIONS.length);
    await stores[0].pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await Promise.all(stores.map((s) => s.close()));
  });

});
