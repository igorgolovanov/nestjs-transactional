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

export interface Account {
  readonly id: string;
  readonly balance: number;
}

/**
 * The relational queries the suites use, typed by hand: Drizzle 0.x
 * types `db.query` from `schema` and 1.0 from `relations`, and the CI
 * matrix type-checks the suites on both.
 */
interface AccountsQuery {
  findMany(): Promise<Account[]>;
  findFirst(): Promise<Account | undefined>;
}

export type TestDb = Omit<PgliteDatabase<typeof schema>, 'query'> & {
  readonly $client: PGlite;
  readonly query: { readonly accounts: AccountsQuery };
};

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
  const db = drizzle({ client: new PGlite(), ...relationalConfig() }) as unknown as TestDb;
  await db.execute(sql`CREATE TABLE accounts (id text PRIMARY KEY, balance integer NOT NULL)`);
  return db;
}

export async function accountIds(db: TestDb): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts).orderBy(accounts.id);
  return rows.map((row) => row.id);
}

/**
 * The SQLSTATE of a failed query: on the error itself before Drizzle
 * 0.44, on its `cause` since then, when Drizzle wraps it in
 * `DrizzleQueryError`.
 */
export function sqlStateOf(error: unknown): unknown {
  for (let current = error; typeof current === 'object' && current !== null;) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (code !== undefined) {
      return code;
    }
    current = cause;
  }
  return undefined;
}
