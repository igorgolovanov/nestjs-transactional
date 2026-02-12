import { Logger } from '@nestjs/common';

import { CreateEventPublication1700000000000 } from '../../src/migrations/1700000000000-create-event-publication';
import {
  EVENT_PUBLICATION_ARCHIVE_TABLE,
  EVENT_PUBLICATION_TABLE,
} from '../../src/schema/event-publication-schema';
import { SchemaInitializer } from '../../src/schema/schema-initializer';
import {
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';

async function tableExists(ctx: PostgresTestContext, table: string): Promise<boolean> {
  const rows = await ctx.dataSource.query<Array<{ exists: string | null }>>(
    `SELECT to_regclass($1)::text AS exists`,
    [table],
  );
  return rows[0]?.exists != null;
}

async function listIndexes(ctx: PostgresTestContext, table: string): Promise<string[]> {
  const rows = await ctx.dataSource.query<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
    [table],
  );
  return rows.map((r) => r.indexname).sort();
}

async function dropSchemaTables(ctx: PostgresTestContext): Promise<void> {
  await ctx.dataSource.query(`DROP TABLE IF EXISTS ${EVENT_PUBLICATION_ARCHIVE_TABLE}`);
  await ctx.dataSource.query(`DROP TABLE IF EXISTS ${EVENT_PUBLICATION_TABLE}`);
}

describe('Schema initialization (integration, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;

  beforeAll(async () => {
    // No entities, no synchronize — start from a truly empty database.
    ctx = await startPostgresContainer();
  });

  afterAll(async () => {
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    await dropSchemaTables(ctx);
  });

  describe('SchemaInitializer', () => {
    it('enabled=false leaves the database untouched', async () => {
      const initializer = new SchemaInitializer(ctx.dataSource, { enabled: false });
      await initializer.onApplicationBootstrap();

      expect(await tableExists(ctx, EVENT_PUBLICATION_TABLE)).toBe(false);
      expect(await tableExists(ctx, EVENT_PUBLICATION_ARCHIVE_TABLE)).toBe(false);
    });

    it('enabled=true on an empty database creates both tables and all indexes', async () => {
      const initializer = new SchemaInitializer(ctx.dataSource, { enabled: true });
      await initializer.onApplicationBootstrap();

      expect(await tableExists(ctx, EVENT_PUBLICATION_TABLE)).toBe(true);
      expect(await tableExists(ctx, EVENT_PUBLICATION_ARCHIVE_TABLE)).toBe(true);

      const hotIndexes = await listIndexes(ctx, EVENT_PUBLICATION_TABLE);
      expect(hotIndexes).toEqual(
        expect.arrayContaining([
          'idx_event_publication_status_date',
          'idx_event_publication_status_listener',
          'idx_event_publication_event_type',
          'idx_event_publication_completion_date',
        ]),
      );

      const archiveIndexes = await listIndexes(ctx, EVENT_PUBLICATION_ARCHIVE_TABLE);
      expect(archiveIndexes).toEqual(
        expect.arrayContaining([
          'idx_event_publication_archive_completion_date',
          'idx_event_publication_archive_listener',
          'idx_event_publication_archive_event_type',
        ]),
      );
    });

    it('enabled=true is idempotent when the hot table already exists', async () => {
      const first = new SchemaInitializer(ctx.dataSource, { enabled: true });
      await first.onApplicationBootstrap();

      // Re-running must not throw — the initializer bails out on the
      // existence check before issuing any DDL.
      const second = new SchemaInitializer(ctx.dataSource, { enabled: true });
      await expect(second.onApplicationBootstrap()).resolves.toBeUndefined();

      expect(await tableExists(ctx, EVENT_PUBLICATION_TABLE)).toBe(true);
    });
  });

  describe('CreateEventPublication1700000000000 migration', () => {
    it('up() creates both tables; down() drops them', async () => {
      const migration = new CreateEventPublication1700000000000();
      const queryRunner = ctx.dataSource.createQueryRunner();
      try {
        await queryRunner.connect();

        await migration.up(queryRunner);
        expect(await tableExists(ctx, EVENT_PUBLICATION_TABLE)).toBe(true);
        expect(await tableExists(ctx, EVENT_PUBLICATION_ARCHIVE_TABLE)).toBe(true);

        await migration.down(queryRunner);
        expect(await tableExists(ctx, EVENT_PUBLICATION_TABLE)).toBe(false);
        expect(await tableExists(ctx, EVENT_PUBLICATION_ARCHIVE_TABLE)).toBe(false);
      } finally {
        await queryRunner.release();
      }
    });

    it('down() is tolerant of a missing or partially applied schema', async () => {
      const migration = new CreateEventPublication1700000000000();
      const queryRunner = ctx.dataSource.createQueryRunner();
      try {
        await queryRunner.connect();
        // Never ran up() — down() must still complete cleanly thanks
        // to the `IF EXISTS` guard in revertEventPublicationSchema.
        await expect(migration.down(queryRunner)).resolves.toBeUndefined();
      } finally {
        await queryRunner.release();
      }
    });
  });
});
