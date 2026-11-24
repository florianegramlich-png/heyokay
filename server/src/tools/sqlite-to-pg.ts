import { DatabaseSync } from 'node:sqlite';
import { PgStore } from '../pg.js';

/**
 * One-off copy of the production SQLite file into Postgres (scaling step 1, docs/ARCHITECTURE.md §8).
 *
 *   DATABASE_URL=… DATABASE_SCHEMA=heyokay node dist/tools/sqlite-to-pg.js /data/heyokay.db
 *
 * Creates the schema and runs the migrations, then copies every table in foreign-key order. Rows
 * that already exist are skipped, so it is safe to run again (e.g. a final catch-up right before
 * switching DATABASE_URL). Sign-in codes and worker leases are short-lived and not copied.
 * Prints row counts per table; never prints row contents.
 */
type Row = Record<string, unknown>;

interface TableCopy {
  table: string;
  columns: string[];
  /** Postgres cast per column, where the text from SQLite needs one. */
  casts?: Record<string, string>;
  /** Source column name, where it differs. */
  from?: Record<string, string>;
}

export const TABLES: TableCopy[] = [
  { table: 'users', columns: ['id', 'token_hash', 'push_token', 'prefs', 'lat', 'lon', 'location_updated_at', 'created_at'], casts: { prefs: 'jsonb' } },
  { table: 'devices', columns: ['token_hash', 'user_id', 'created_at'] },
  { table: 'accounts', columns: ['id', 'email', 'user_id', 'created_at'] },
  { table: 'account_identities', columns: ['provider', 'subject', 'account_id', 'created_at'] },
  { table: 'saved_places', columns: ['id', 'user_id', 'label', 'lat', 'lon', 'radius_m'] },
  { table: 'source_items', columns: ['source', 'external_id', 'payload', 'event_id', 'first_seen_at'], casts: { payload: 'jsonb' } },
  { table: 'events', columns: ['id', 'data', 'status', 'category', 'lat', 'lon', 'starts_at', 'ends_at', 'updated_at'], casts: { data: 'jsonb' } },
  { table: 'event_embeddings', columns: ['event_id', 'model', 'embedding', 'updated_at'], casts: { embedding: 'public.vector' }, from: { embedding: 'vector' } },
  { table: 'alerts', columns: ['id', 'user_id', 'event_id', 'event_revision', 'data', 'delivery', 'feedback', 'created_at'], casts: { data: 'jsonb' } },
  { table: 'reviewers', columns: ['id', 'email', 'name', 'password_hash', 'created_at', 'disabled'], casts: { disabled: 'boolean' } },
  { table: 'decisions', columns: ['id', 'at', 'kind', 'event_id', 'data'], casts: { data: 'jsonb' } },
  { table: 'push_tickets', columns: ['id', 'ticket_id', 'alert_id', 'user_id', 'token', 'status', 'error', 'attempt', 'created_at', 'checked_at'] },
];

export interface CopyReport { [table: string]: { source: number; copied: number; skipped: number; failed: number } }

export async function copySqliteToPg(sqlitePath: string, pg: PgStore, log: (line: string) => void = () => {}): Promise<CopyReport> {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const report: CopyReport = {};
  try {
    for (const t of TABLES) {
      const srcCols = t.columns.map((c) => t.from?.[c] ?? c);
      let rows: Row[];
      try {
        rows = db.prepare(`SELECT ${srcCols.join(', ')} FROM ${t.table}`).all() as Row[];
      } catch {
        rows = []; // table didn't exist yet in this SQLite file
      }
      const values = t.columns.map((c, i) => `$${i + 1}${t.casts?.[c] ? `::${t.casts[c]}` : ''}`).join(', ');
      const sql = `INSERT INTO ${t.table} (${t.columns.join(', ')}) VALUES (${values}) ON CONFLICT DO NOTHING`;
      const r = { source: rows.length, copied: 0, skipped: 0, failed: 0 };
      const client = await pg.pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          await client.query('SAVEPOINT row');
          try {
            const res = await client.query(sql, srcCols.map((c) => row[c] ?? null));
            res.rowCount ? r.copied++ : r.skipped++;
            await client.query('RELEASE SAVEPOINT row');
          } catch (err) {
            // e.g. a place radius over today's limit, or an alert for a deleted user: count it, keep going.
            await client.query('ROLLBACK TO SAVEPOINT row');
            if (r.failed === 0) log(`  ${t.table}: first failure — ${(err as Error).message}`);
            r.failed++;
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      report[t.table] = r;
      log(`${t.table.padEnd(18)} ${String(r.source).padStart(7)} in SQLite · ${r.copied} copied · ${r.skipped} already there · ${r.failed} failed`);
    }
  } finally {
    db.close();
  }
  return report;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? process.env.DB_PATH ?? './heyokay.db';
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL (and DATABASE_SCHEMA, e.g. heyokay).'); process.exit(1); }
  const schema = process.env.DATABASE_SCHEMA || undefined;
  const pg = await PgStore.connect(url, schema ? { schema } : {});
  try {
    const report = await copySqliteToPg(path, pg, console.log);
    const failed = Object.values(report).reduce((n, r) => n + r.failed, 0);
    console.log(failed ? `Done with ${failed} rows that could not be copied (see above).` : 'Done. Every row is in Postgres.');
  } finally {
    await pg.close();
  }
}
