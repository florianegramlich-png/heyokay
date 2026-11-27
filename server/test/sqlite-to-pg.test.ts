import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../src/db.js';
import { PgStore } from '../src/pg.js';
import { copySqliteToPg } from '../src/tools/sqlite-to-pg.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('SQLite → Postgres copy', () => {
  it('copies everything once; a second run skips; the copy works as a store', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hk-')), 'h.db');
    const src = new SqliteStore(file);
    const { user, token } = await src.createUser('ExponentPushToken[x]', { language: 'en' });
    await src.updateLocation(user.id, 52.52, 13.405);
    await src.addPlace(user.id, 'Mama', 48.137, 11.575, 500);
    await src.createAccount('a@example.org', user.id);
    await src.close();

    const pg = await PgStore.connect(url!, { schema: `t_${randomBytes(6).toString('hex')}`, dropSchemaOnClose: true, max: 2 });
    try {
      const first = await copySqliteToPg(file, pg);
      expect(first.users).toEqual({ source: 1, copied: 1, skipped: 0, failed: 0 });
      expect(first.saved_places.copied).toBe(1);
      expect(first.devices.copied).toBe(1);
      const again = await copySqliteToPg(file, pg);
      expect(again.users).toEqual({ source: 1, copied: 0, skipped: 1, failed: 0 });

      // The person signs in with the same token and is found by location, now via PostGIS.
      const me = await pg.userByToken(token);
      expect(me?.prefs.language).toBe('en');
      expect((await pg.places(user.id))[0].label).toBe('Mama');
      expect((await pg.accountByEmail('a@example.org'))?.userId).toBe(user.id);
      const near = await pg.usersNear({ lat: 48.137, lon: 11.575, radiusM: 1000 }, 0, new Date());
      expect(near.map((u) => u.user.id)).toContain(user.id);
    } finally {
      await pg.close();
    }
  });

  it('copies the family share switch; an older file without it copies as not shared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-'));
    const file = join(dir, 'h.db'), old = join(dir, 'old.db');
    for (const f of [file, old]) {
      const src = new SqliteStore(f);
      const { user } = await src.createUser(null);
      const p = await src.addPlace(user.id, 'Zuhause', 48.137, 11.575, 500);
      await src.setPlaceShared(user.id, p.id, true);
      await src.close();
    }
    const raw = new DatabaseSync(old);
    raw.exec('ALTER TABLE saved_places DROP COLUMN shared');
    raw.close();
    for (const [f, shared] of [[file, true], [old, false]] as const) {
      const pg = await PgStore.connect(url!, { schema: `t_${randomBytes(6).toString('hex')}`, dropSchemaOnClose: true, max: 2 });
      try {
        expect((await copySqliteToPg(f, pg)).saved_places).toEqual({ source: 1, copied: 1, skipped: 0, failed: 0 });
        const { rows } = await pg.pool.query('SELECT shared FROM saved_places');
        expect(rows).toEqual([{ shared }]);
      } finally {
        await pg.close();
      }
    }
  });
});
