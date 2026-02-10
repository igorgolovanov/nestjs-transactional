import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource, type DataSourceOptions } from 'typeorm';

/**
 * Postgres test context returned by {@link startPostgresContainer}.
 * Bundles the running container with an already-initialised
 * {@link DataSource} pointing at it — everything an integration test
 * needs, and together they must be stopped via
 * {@link stopPostgresContainer}.
 */
export interface PostgresTestContext {
  readonly container: StartedPostgreSqlContainer;
  readonly dataSource: DataSource;
}

export interface StartPostgresOptions {
  /** Postgres image to run. Defaults to `postgres:16-alpine`. */
  readonly image?: string;
  /** Entities to register with the DataSource. */
  readonly entities?: DataSourceOptions['entities'];
  /** Run TypeORM's `synchronize` on startup. Defaults to `false`. */
  readonly synchronize?: boolean;
}

/**
 * Start a Postgres container via testcontainers-node and return an
 * initialised TypeORM {@link DataSource} pointed at it. Mirror of the
 * helper in `packages/typeorm/test/setup-testcontainers.ts` — kept
 * self-contained so that the outbox-typeorm integration suite does not
 * reach into a sibling package's test tree.
 */
export async function startPostgresContainer(
  options: StartPostgresOptions = {},
): Promise<PostgresTestContext> {
  const container = await new PostgreSqlContainer(options.image ?? 'postgres:16-alpine').start();

  const dataSource = new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
    entities: options.entities,
    synchronize: options.synchronize ?? false,
    logging: false,
  });

  await dataSource.initialize();

  return { container, dataSource };
}

/** Dispose of the DataSource and stop the container. Idempotent-ish. */
export async function stopPostgresContainer(ctx: PostgresTestContext): Promise<void> {
  if (ctx.dataSource.isInitialized) {
    await ctx.dataSource.destroy();
  }
  await ctx.container.stop();
}
