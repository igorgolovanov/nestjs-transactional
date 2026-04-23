import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource, type DataSourceOptions } from 'typeorm';

/**
 * Postgres test context returned by {@link startPostgresContainer}.
 * Bundle the running container with an already-initialised
 * {@link DataSource} pointing at it — together they're everything an
 * integration test needs and together they must be stopped via
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
 * initialised TypeORM {@link DataSource} pointed at it. Typical usage in
 * a Jest suite:
 *
 * ```ts
 * let ctx: PostgresTestContext;
 * beforeAll(async () => { ctx = await startPostgresContainer(); });
 * afterAll(async () => { await stopPostgresContainer(ctx); });
 * ```
 *
 * Container startup takes several seconds on the first run (image pull)
 * and a second or two on subsequent runs. Size your Jest timeout
 * accordingly — integration tests typically want 30–60 seconds.
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

/**
 * Create a second database inside the running Postgres container and
 * return an initialised {@link DataSource} pointing at it. Useful for
 * multi-datasource integration tests that need two logically independent
 * DataSources without paying the cost of a second container.
 *
 * Caller is responsible for destroying the returned DataSource before
 * `stopPostgresContainer` is called.
 */
export async function createAdditionalDatabase(
  ctx: PostgresTestContext,
  databaseName: string,
  options: Pick<StartPostgresOptions, 'entities' | 'synchronize'> = {},
): Promise<DataSource> {
  await ctx.dataSource.query(`CREATE DATABASE ${databaseName}`);

  const secondary = new DataSource({
    type: 'postgres',
    host: ctx.container.getHost(),
    port: ctx.container.getPort(),
    username: ctx.container.getUsername(),
    password: ctx.container.getPassword(),
    database: databaseName,
    entities: options.entities,
    synchronize: options.synchronize ?? false,
    logging: false,
  });
  await secondary.initialize();
  return secondary;
}
