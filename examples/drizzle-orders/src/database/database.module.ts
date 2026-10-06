import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { schema } from './schema.js';

/** The token the application's Drizzle database is registered under. */
export const DB = Symbol('DB');
const POOL = Symbol('POOL');

export type Database = NodePgDatabase<typeof schema>;

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export function readPostgresConfigFromEnv(): PostgresConfig {
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'postgres',
  };
}

/**
 * How an application usually provides Drizzle to Nest, which has no
 * Drizzle module of its own: a pool, and `drizzle()` on it under a token
 * of the application's choosing. Nothing here knows about transactions;
 * `TransactionalDrizzleModule.forRoot({ db: DB })` makes this same
 * instance follow `@Transactional`.
 */
@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  static forPostgres(config: PostgresConfig): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: POOL, useFactory: () => new pg.Pool(config) },
        {
          provide: DB,
          inject: [POOL],
          useFactory: async (pool: pg.Pool): Promise<Database> => {
            const db = drizzle({ client: pool, schema });
            // Example-only; production runs drizzle-kit migrations. The
            // outbox and the workflow store create their own schemas.
            await db.execute(sql`
              CREATE TABLE IF NOT EXISTS orders (
                id text PRIMARY KEY,
                sku text NOT NULL,
                amount_cents integer NOT NULL,
                status text NOT NULL
              )
            `);
            return db;
          },
        },
      ],
      exports: [DB],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
