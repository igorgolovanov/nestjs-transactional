import 'reflect-metadata';

import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import {
  OUTBOX_PROCESSOR_OPTIONS,
  OutboxModule,
  PublicationStatus,
} from '@nestjs-transactional/outbox';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AuditArchivalHandler } from '../src/audit/audit-archival.handler';
import { AuditLogEntry } from '../src/audit/audit-log.entity';
import { AuditService } from '../src/audit/audit.service';

const repoRoot = join(__dirname, '..');
const envDevelopment = join(repoRoot, '.env.development');
const envProduction = join(repoRoot, '.env.production');
const envMissingRequired = join(__dirname, 'fixtures', '.env.missing-required');
const envBadPolling = join(__dirname, 'fixtures', '.env.bad-polling');

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function resetModuleState(): void {
  OutboxModule.resetForTesting();
  TransactionalModule.resetForTesting();
  TypeOrmTransactionalModule.resetForTesting();
  OutboxTypeOrmModule.resetForTesting();
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

      await dataSource.getRepository(EventPublicationArchiveEntity).clear();
      await dataSource.getRepository(EventPublicationEntity).clear();
      await dataSource.getRepository(AuditLogEntry).clear();
    });

    afterEach(async () => {
      await module.close();
    });

    it('boots from .env.development and commits the audit row + outbox publication atomically', async () => {
      await audit.recordEvent('a-1', 'UserSignedIn', { userId: 'u-42' });

      const auditRows = await dataSource.getRepository(AuditLogEntry).find();
      const publicationRows = await dataSource
        .getRepository(EventPublicationEntity)
        .find();

      expect(auditRows.map((r) => r.id)).toEqual(['a-1']);
      expect(publicationRows).toHaveLength(1);
      expect(publicationRows[0]?.eventType).toBe('AuditEventRecordedEvent');

      await waitFor(() => archival.archived.some((e) => e.entryId === 'a-1'));

      const completed = await dataSource
        .getRepository(EventPublicationEntity)
        .findOne({ where: { id: publicationRows[0]!.id } });
      expect(completed?.status).toBe(PublicationStatus.COMPLETED);
    });

    it('injects dev-profile outbox tunables into OUTBOX_PROCESSOR_OPTIONS', () => {
      const options = module.get<{
        pollingInterval: number;
        batchSize: number;
        maxConcurrent: number;
      }>(OUTBOX_PROCESSOR_OPTIONS);

      // Mirror .env.development values — proves the async factory
      // actually read them and passed them through to the outbox
      // processor, not the framework defaults.
      expect(options.pollingInterval).toBe(100);
      expect(options.batchSize).toBe(50);
      expect(options.maxConcurrent).toBe(10);
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
        const options = module.get<{
          pollingInterval: number;
          batchSize: number;
          maxConcurrent: number;
        }>(OUTBOX_PROCESSOR_OPTIONS);

        // Mirror .env.production values — different from dev profile,
        // proving NODE_ENV / envFilePath actually switches the
        // resolved config end-to-end.
        expect(options.pollingInterval).toBe(2000);
        expect(options.batchSize).toBe(500);
        expect(options.maxConcurrent).toBe(50);
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
  });
});
