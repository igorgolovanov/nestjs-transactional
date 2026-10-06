import { PGlite } from '@electric-sql/pglite';
import * as orm from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  balance: integer('balance').notNull(),
});

export const schema = { accounts };

export type TestDb = PgliteDatabase<typeof schema> & { $client: PGlite };

/**
 * An in-process PostgreSQL (PGlite) with the `accounts` table, for the
 * unit suites: real PostgreSQL semantics, no Docker. PGlite has a
 * single connection, so nothing here can run two transactions at once;
 * REQUIRES_NEW and concurrency are covered by the integration suite.
 */
/**
 * What makes `db.query.accounts` exist. Drizzle 0.x builds the relational
 * API from `schema`; 1.0 builds it from `relations` (`defineRelations`)
 * and leaves the schema-based one as `db._query`. The CI matrix runs the
 * suites on both lines, so the helper picks by what `drizzle-orm` has.
 */
function relationalConfig(): { schema: typeof schema } {
  const defineRelations = (orm as Record<string, unknown>).defineRelations;
  return typeof defineRelations === 'function'
    ? ({ relations: (defineRelations as (s: object) => unknown)(schema) } as never)
    : { schema };
}

export async function createTestDb(): Promise<TestDb> {
  const db = drizzle({ client: new PGlite(), ...relationalConfig() });
  await db.execute(sql`CREATE TABLE accounts (id text PRIMARY KEY, balance integer NOT NULL)`);
  return db;
}

export async function accountIds(db: TestDb): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts).orderBy(accounts.id);
  return rows.map((row) => row.id);
}
