import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { ArticleQueryService } from './article.query-service';
import { ArticleRow } from './article.entity';
import { ArticleService } from './article.service';

export interface PostgresConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export interface ReadWriteSeparationConfig {
  readonly master: PostgresConnection;
  readonly replica: PostgresConnection;
}

export function readConfigFromEnv(): ReadWriteSeparationConfig {
  const shared = {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
  };
  return {
    master: { ...shared, database: process.env.PGMASTER ?? 'app' },
    replica: { ...shared, database: process.env.PGREPLICA ?? 'app' },
  };
}

/**
 * Two TypeORM `DataSource` registrations pointing at master and
 * replica Postgres hosts. The conventional axes:
 *
 * - **`'default'` (master)** — receives all writes through
 *   `@Transactional`. `synchronize: true` is acceptable here in
 *   examples; production replaces it with migrations.
 * - **`'replica'`** — read-only path. `synchronize: false` is
 *   important: a real Postgres read replica rejects DDL (and even
 *   DML on its own session, depending on `default_transaction_read_only`),
 *   so the example sets the same flag here even though our
 *   testcontainers replica is writable.
 *
 * Only the master DS is registered with
 * `TypeOrmTransactionalModule.forRoot`. This is intentional:
 *
 * - Writes inside `@Transactional` route to master automatically
 *   (master is the only adapter, and the only DS bound to a
 *   transactional context).
 * - `@Transactional({ dataSource: 'replica' })` fails fast at
 *   bootstrap with "no adapter for dataSource 'replica'" — the
 *   framework refuses to silently fall back to autocommit.
 *
 * ### Alternative: TypeORM's native `replication` option
 *
 * TypeORM's `DataSource` config accepts a `replication: { master,
 * slaves: [...] }` shape that internally routes writes to the
 * master connection and reads to one of the slave connections.
 * That keeps the connection pool inside ONE `DataSource` and
 * therefore one set of migrations / one entity registration. It's
 * a fine alternative when:
 *
 * - All slaves replicate the master via Postgres streaming
 *   replication (so they share one schema).
 * - You don't need different connection settings (timeout, schema)
 *   per slave.
 *
 * The two-DataSource shape in this example is preferable when:
 *
 * - The "replica" is logically separate (e.g. an analytics replica
 *   that runs a different read schema with materialised views).
 * - You want different DI tokens for read vs write repositories so
 *   a misplaced write throws at compile time, not at SQL time.
 *
 * Both shapes are valid; pick based on what you want the failure
 * mode of "wrong target" to look like.
 */
@Module({})
export class AppModule {
  static forConfig(config: ReadWriteSeparationConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Master (default) — write target.
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config.master,
          entities: [ArticleRow],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([ArticleRow]),

        // Replica — read target. `synchronize: false` mirrors the
        // production constraint that replicas are read-only.
        TypeOrmModule.forRoot({
          name: 'replica',
          type: 'postgres',
          ...config.replica,
          entities: [ArticleRow],
          synchronize: false,
          logging: false,
        }),
        TypeOrmModule.forFeature([ArticleRow], 'replica'),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        // ONLY master is registered with the transactional adapter.
        // No `forRoot({ dataSource: 'replica' })` — see class JSDoc.
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
      ],
      providers: [ArticleService, ArticleQueryService],
    };
  }
}
