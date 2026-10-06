import 'reflect-metadata';

import { join } from 'node:path';

import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { OUTBOX_MODULE_OPTIONS, type OutboxModuleOptions } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { AuditArchivalHandler } from '../src/audit/audit-archival.handler.js';
import { AuditLogEntry } from '../src/audit/audit-log.entity.js';
import { AuditService } from '../src/audit/audit.service.js';

// `import.meta.dirname` rather than `__dirname`: the example is ESM.
const repoRoot = join(import.meta.dirname, '..');
const envDevelopment = join(repoRoot, '.env.development');
const envProduction = join(repoRoot, '.env.production');
const envMissingRequired = join(import.meta.dirname, 'fixtures', '.env.missing-required');
const envBadPolling = join(import.meta.dirname, 'fixtures', '.env.bad-polling');
const envTwoViolations = join(import.meta.dirname, 'fixtures', '.env.two-violations');

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function resetModuleState(): void {
  TransactionalModule.resetForTesting();
  TransactionalTypeOrmModule.resetForTesting();
}

/**
 * Keys that ConfigModule may write to `process.env` from any of the
 * fixture `.env` files. Restoring these between tests prevents an
 * earlier test's loaded values from masking a later test's
 * intentionally-different (or deliberately-missing) values — dotenv
 * by default refuses to overwrite a key already in `process.env`.
 */
const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'PG_HOST',
  'PG_PORT',
  'PG_USER',
  'PG_PASSWORD',
  'PG_DATABASE',
  'OUTBOX_POLLING_INTERVAL_MS',
  'OUTBOX_BATCH_SIZE',
  'OUTBOX_MAX_CONCURRENT',
  'HTTP_PORT',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(MANAGED_ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of MANAGED_ENV_KEYS) {
    const original = snapshot[k];
    if (original === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = original;
    }
  }
}

describe('async-config-from-environment (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let envSnapshot: Record<string, string | undefined>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    envSnapshot = snapshotEnv();
  }, 60_000);

  afterAll(async () => {
    await container.stop();
    restoreEnv(envSnapshot);
  });

  beforeEach(() => {
    resetModuleState();
    // dotenv (used by ConfigModule under the hood) refuses to
    // overwrite an existing `process.env` key, so a prior test's
    // .env load would mask the current test's values without this
    // reset. Always start each test from a clean baseline.
    restoreEnv(envSnapshot);
  });

  describe('dev profile (.env.development)', () => {
    let module: TestingModule;
    let dataSource: DataSource;
    let audit: AuditService;
    let archival: AuditArchivalHandler;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [
          AppModule.forEnv({
            envFilePath: envDevelopment,
            databaseOverride: {
              host: container.getHost(),
              port: container.getPort(),
              username: container.getUsername(),
              password: container.getPassword(),
              database: container.getDatabase(),
            },
          }),
        ],
      }).compile();

      await module.init();

      dataSource = module.get<DataSource>(getDataSourceToken());
      audit = module.get(AuditService);
      archival = module.get(AuditArchivalHandler);

      await dataSource.query('TRUNCATE nest_outbox.messages, nest_outbox.inbox');
      await dataSource.getRepository(AuditLogEntry).clear();
    });

    afterEach(async () => {
      await module.close();
    });

    it('boots from .env.development; the audit row commits and its message reaches the handler', async () => {
      await audit.recordEvent('a-1', 'UserSignedIn', { userId: 'u-42' });

      const auditRows = await dataSource.getRepository(AuditLogEntry).find();
      expect(auditRows.map((r) => r.id)).toEqual(['a-1']);

      // The relay polls every 100 ms in this profile, so delivery is
      // asynchronous: wait for the handler, then for its inbox record.
      await waitFor(() => archival.archived.some((e) => e.entryId === 'a-1'));
      await waitFor(async () => {
        const rows: unknown[] = await dataSource.query(
          `SELECT 1 FROM nest_outbox.inbox WHERE consumer = 'audit.archival'`,
        );
        return rows.length === 1;
      });
    });

    it('passes the dev-profile relay tunables to @nestjs/outbox', () => {
      const options = module.get<OutboxModuleOptions>(OUTBOX_MODULE_OPTIONS);

      // Mirror .env.development values: the async factory read them and
      // passed them through, rather than the package defaults.
      expect(options.relay).toMatchObject({ pollInterval: 100, batchSize: 50, concurrency: 10 });
    });
  });

  describe('production profile (.env.production)', () => {
    it('injects prod-profile outbox tunables — different values from dev', async () => {
      const module = await Test.createTestingModule({
        imports: [
          AppModule.forEnv({
            envFilePath: envProduction,
            databaseOverride: {
              host: container.getHost(),
              port: container.getPort(),
              username: container.getUsername(),
              password: container.getPassword(),
              database: container.getDatabase(),
            },
          }),
        ],
      }).compile();

      await module.init();

      try {
        const options = module.get<OutboxModuleOptions>(OUTBOX_MODULE_OPTIONS);

        // Mirror .env.production values, different from the dev profile:
        // NODE_ENV / envFilePath really switches the resolved config.
        expect(options.relay).toMatchObject({
          pollInterval: 2000,
          batchSize: 500,
          concurrency: 50,
        });
      } finally {
        await module.close();
      }
    });
  });

  describe('Joi validation (failure modes)', () => {
    // `ConfigModule.forRoot` is `async` — its returned Promise is
    // what rejects on schema violation. Wrapping the import-array
    // construction in a synchronous `expect(() => ...).toThrow`
    // would not catch the rejection; we have to await module
    // compilation.
    it('rejects bootstrap when a required env var is missing', async () => {
      await expect(
        Test.createTestingModule({
          imports: [AppModule.forEnv({ envFilePath: envMissingRequired })],
        }).compile(),
      ).rejects.toThrow(/PG_HOST/);
    });

    it('rejects bootstrap when a numeric env var is out of range', async () => {
      await expect(
        Test.createTestingModule({
          imports: [AppModule.forEnv({ envFilePath: envBadPolling })],
        }).compile(),
      ).rejects.toThrow(/OUTBOX_POLLING_INTERVAL_MS/);
    });

    // The two cases above pass whether validation stops at the first
    // failure or not, so neither one guards the `abortEarly: false`
    // that `forEnv` sets. This one does: with early abort, only
    // whichever rule Joi reaches first would be named, and half the
    // misconfiguration would stay hidden until the next boot.
    it('reports every broken rule in one error, not just the first', async () => {
      let thrown: unknown;
      try {
        await Test.createTestingModule({
          imports: [AppModule.forEnv({ envFilePath: envTwoViolations })],
        }).compile();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const { message } = thrown as Error;
      expect(message).toMatch(/PG_HOST/);
      expect(message).toMatch(/OUTBOX_POLLING_INTERVAL_MS/);
    });
  });
});
