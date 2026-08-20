import type { DataSource, QueryRunner } from 'typeorm';

import {
  EVENT_PUBLICATION_ARCHIVE_TABLE,
  EVENT_PUBLICATION_TABLE,
} from '../../src/schema/event-publication-schema';
import {
  DEFAULT_SCHEMA_INITIALIZATION_OPTIONS,
  type SchemaInitializationOptions,
} from '../../src/schema/schema-initialization-options';
import { SchemaInitializer } from '../../src/schema/schema-initializer';

/**
 * Docker-free companion to
 * `test/integration/schema-initializer.integration.spec.ts`.
 *
 * The integration suite proves the emitted DDL actually builds the
 * schema on Postgres. These specs pin the decisions taken before any
 * DDL is emitted — above all that auto-init stays off unless explicitly
 * switched on, since applying schema at process startup is exactly what
 * production deployments must not do.
 */
describe('SchemaInitializer (unit)', () => {
  function queryRunner(overrides: Partial<QueryRunner> = {}) {
    return {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      createTable: jest.fn().mockResolvedValue(undefined),
      createIndex: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as QueryRunner & {
      connect: jest.Mock;
      release: jest.Mock;
      createTable: jest.Mock;
      createIndex: jest.Mock;
    };
  }

  function dataSource(args: { tableExists: boolean; runner?: QueryRunner }) {
    const query = jest
      .fn()
      .mockResolvedValue([{ exists: args.tableExists ? EVENT_PUBLICATION_TABLE : null }]);
    const createQueryRunner = jest.fn().mockReturnValue(args.runner ?? queryRunner());
    return {
      ds: { query, createQueryRunner } as unknown as DataSource,
      query,
      createQueryRunner,
    };
  }

  function initializer(ds: DataSource, options: SchemaInitializationOptions) {
    return new SchemaInitializer(ds, options);
  }

  it('defaults to disabled, so migrations stay the only way schema reaches production', () => {
    expect(DEFAULT_SCHEMA_INITIALIZATION_OPTIONS.enabled).toBe(false);
  });

  it('does not even probe the database when disabled', async () => {
    const { ds, query, createQueryRunner } = dataSource({ tableExists: false });

    await initializer(ds, { enabled: false }).onApplicationBootstrap();

    expect(query).not.toHaveBeenCalled();
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('leaves an existing schema untouched', async () => {
    const { ds, query, createQueryRunner } = dataSource({ tableExists: true });

    await initializer(ds, { enabled: true }).onApplicationBootstrap();

    expect(query).toHaveBeenCalledTimes(1);
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('creates both the hot and the archive table when the schema is missing', async () => {
    const runner = queryRunner();
    const { ds } = dataSource({ tableExists: false, runner });

    await initializer(ds, { enabled: true }).onApplicationBootstrap();

    expect(runner.connect).toHaveBeenCalledTimes(1);
    const createdTables = runner.createTable.mock.calls.map(
      ([table]: [{ name: string }]) => table.name,
    );
    expect(createdTables).toEqual([EVENT_PUBLICATION_TABLE, EVENT_PUBLICATION_ARCHIVE_TABLE]);
    expect(runner.createIndex).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('releases the query runner even when schema creation fails', async () => {
    // A leaked query runner exhausts the pool, turning a one-off DDL
    // error into an app that cannot serve traffic.
    const runner = queryRunner({
      createTable: jest.fn().mockRejectedValue(new Error('permission denied')),
    });
    const { ds } = dataSource({ tableExists: false, runner });

    await expect(initializer(ds, { enabled: true }).onApplicationBootstrap()).rejects.toThrow(
      'permission denied',
    );

    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('treats a null regclass probe as "table missing"', async () => {
    // `to_regclass` returns null rather than an empty row set, so the
    // probe reads the column, not the row count.
    const runner = queryRunner();
    const ds = {
      query: jest.fn().mockResolvedValue([{ exists: null }]),
      createQueryRunner: jest.fn().mockReturnValue(runner),
    } as unknown as DataSource;

    await initializer(ds, { enabled: true }).onApplicationBootstrap();

    expect(runner.createTable).toHaveBeenCalled();
  });

  it('treats an empty probe result as "table missing" rather than crashing', async () => {
    const runner = queryRunner();
    const ds = {
      query: jest.fn().mockResolvedValue([]),
      createQueryRunner: jest.fn().mockReturnValue(runner),
    } as unknown as DataSource;

    await initializer(ds, { enabled: true }).onApplicationBootstrap();

    expect(runner.createTable).toHaveBeenCalled();
  });
});
