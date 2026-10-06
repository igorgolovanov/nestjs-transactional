import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import pg from 'pg';
import postgres from 'postgres';

import { schema } from './pglite.js';

/** The two PostgreSQL drivers the integration suites run on. */
export const DRIVERS = ['node-postgres', 'postgres-js'] as const;
export type Driver = (typeof DRIVERS)[number];

/** A drizzle() database typed with the test schema, on either driver. */
export type IntegrationDb = NodePgDatabase<typeof schema>;

export interface PostgresContext {
  readonly container: StartedPostgreSqlContainer;
  /** The account ids committed so far, read on a connection of its own. */
  committedIds(): Promise<string[]>;
  /** Rows of `text`, run on a connection of its own: what is committed. */
  committed<T>(text: string): Promise<T[]>;
  /** A database of its own, on `driver`, with a pool of several connections. */
  connect(driver: Driver): Promise<ConnectedDb>;
}

export interface ConnectedDb {
  readonly db: IntegrationDb;
  close(): Promise<void>;
}

export async function startPostgres(): Promise<PostgresContext> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = container.getConnectionUri();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('CREATE TABLE accounts (id text PRIMARY KEY, balance integer NOT NULL)');
  await admin.end();

  const committed = async <T>(text: string): Promise<T[]> => {
    const reader = new pg.Client({ connectionString: url });
    await reader.connect();
    try {
      return (await reader.query(text)).rows as T[];
    } finally {
      await reader.end();
    }
  };

  return {
    container,
    committed,
    async committedIds() {
      const rows = await committed<{ id: string }>('SELECT id FROM accounts ORDER BY id');
      return rows.map((row) => row.id);
    },
    async connect(driver) {
      if (driver === 'node-postgres') {
        const pool = new pg.Pool({ connectionString: url, max: 5 });
        return { db: drizzleNodePg({ client: pool, schema }), close: () => pool.end() };
      }
      const client = postgres(url, { max: 5, onnotice: () => undefined });
      return {
        db: drizzlePostgresJs({ client, schema }) as unknown as IntegrationDb,
        close: () => client.end(),
      };
    },
  };
}

export async function clearAccounts(db: IntegrationDb): Promise<void> {
  await db.execute(sql`TRUNCATE accounts`);
}
