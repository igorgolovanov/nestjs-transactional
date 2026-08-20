import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, PublicationStatus } from '@nestjs-transactional/outbox';
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
import { Client } from 'pg';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AuditLogEntry } from '../src/audit/audit-log.entity';
import { AuditService } from '../src/audit/audit.service';
import {
  HANDLER_LATENCY_MS,
  SlowArchivalHandler,
} from '../src/audit/slow-archival.handler';
import { ExampleCleanupService } from '../src/shutdown/example-cleanup.service';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function resetModuleState(): void {
  OutboxModule.resetForTesting();
  TransactionalModule.resetForTesting();
  TypeOrmTransactionalModule.resetForTesting();
  OutboxTypeOrmModule.resetForTesting();
}

describe('graceful-shutdown (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let audit: AuditService;
  let archival: SlowArchivalHandler;
  let cleanup: ExampleCleanupService;
  // Separate connection for post-close verification — `module.close()`
  // closes the TypeORM DataSource so any reads through it after that
  // would throw "Driver not Connected". A side pg client lets the
  // assertions inspect Postgres state even after the app shut down.
  let verifyClient: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    verifyClient = new Client({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    });
    await verifyClient.connect();
  }, 60_000);

  afterAll(async () => {
    await verifyClient.end();
    await container.stop();
  });

  beforeEach(async () => {
    resetModuleState();

    module = await Test.createTestingModule({
      imports: [
        AppModule.forPostgres({
          host: container.getHost(),
          port: container.getPort(),
          username: container.getUsername(),
          password: container.getPassword(),
          database: container.getDatabase(),
        }),
      ],
    }).compile();

    // `app.close()` triggers all OnApplicationShutdown hooks. We do
    // NOT call `enableShutdownHooks` in tests — that wires Node
    // signal handlers, which would interfere with Jest's own.
    await module.init();

    dataSource = module.get<DataSource>(getDataSourceToken());
    audit = module.get(AuditService);
    archival = module.get(SlowArchivalHandler);
    cleanup = module.get(ExampleCleanupService);

    await dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await dataSource.getRepository(EventPublicationEntity).clear();
    await dataSource.getRepository(AuditLogEntry).clear();
  });

  it('closes cleanly from an idle state — no in-flight work, hooks fire', async () => {
    // Nothing dispatched, nothing to drain. The hook chain still
    // runs in full so user-defined cleanup (ExampleCleanupService)
    // still executes — that's the contract callers depend on.
    expect(archival.started).toBe(0);

    const closeStarted = Date.now();
    await module.close();

    // An idle drain must not cost the shutdown budget — nothing is in
    // flight, so `stop()` resolves without waiting.
    expect(Date.now() - closeStarted).toBeLessThan(1_000);
    expect(cleanup.cleaned).toBe(true);
  });

  it('completes an in-flight handler invocation before tearing down the DataSource', async () => {
    // Record one event so the worker has something to dispatch.
    await audit.recordEvent('a-1', 'shutdown mid-handler');

    // Worker polling at 50ms — the slow handler (400ms latency)
    // is guaranteed to be mid-flight when we trip shutdown.
    await waitFor(() => archival.started === 1);
    expect(archival.finished).toBe(0); // still inside the handler

    const closeStarted = Date.now();
    await module.close();
    const closeDuration = Date.now() - closeStarted;

    // `OutboxProcessingModule.onApplicationShutdown` awaits the
    // in-flight batch, so close() cannot return before the handler's
    // remaining latency has elapsed.
    expect(closeDuration).toBeGreaterThanOrEqual(HANDLER_LATENCY_MS / 2);

    // Handler finished cleanly — no row stuck in PROCESSING.
    expect(archival.finished).toBe(1);

    // Verify via the side pg client (the Nest-managed DataSource is
    // already closed at this point).
    const result = await verifyClient.query<{ status: string }>(
      'SELECT status FROM event_publication',
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.status).toBe(PublicationStatus.COMPLETED);
  });

  it('preserves single-unit atomicity when a transaction races shutdown', async () => {
    // Kick off a recordEvent (audit_log + outbox publication in one tx)
    // and request shutdown immediately. Which one wins is a genuine
    // race, and deliberately left as one: the outbox worker's in-flight
    // batch is drained before teardown, but a business transaction begun
    // microseconds before `close()` is tracked by nothing, and NestJS
    // destroys the DataSource once the shutdown hooks return.
    //
    // So assert the invariant that holds either way instead of a winner.
    // Asserting the commit made this test depend on beating provider
    // teardown — true on a fast machine, false on a CI runner, where it
    // failed with `QueryFailedError: Connection terminated`.
    const [recorded] = await Promise.allSettled([
      audit.recordEvent('a-2', 'tx mid-shutdown'),
      module.close(),
    ]);

    const auditRows = await verifyClient.query<{ id: string }>(
      'SELECT id FROM audit_log',
    );
    const pubRows = await verifyClient.query<{ event_type: string }>(
      'SELECT event_type FROM event_publication',
    );

    if (recorded.status === 'fulfilled') {
      // Committed before teardown reached the DataSource: both rows.
      expect(auditRows.rows.map((r) => r.id)).toEqual(['a-2']);
      expect(pubRows.rows).toHaveLength(1);
      expect(pubRows.rows[0]?.event_type).toBe('AuditEventRecordedEvent');
    } else {
      // Lost the race, and the connection went away mid-transaction.
      // Postgres rolled it back — and DD-019's single unit means the
      // business row and the publication cannot survive separately, so
      // neither may be here.
      expect(auditRows.rows).toHaveLength(0);
      expect(pubRows.rows).toHaveLength(0);
    }

    // Either way the hook chain ran to completion.
    expect(cleanup.cleaned).toBe(true);
  });

  it('runs user-defined OnApplicationShutdown hooks alongside the framework hooks', async () => {
    expect(cleanup.cleaned).toBe(false);

    await module.close();

    // The hook ran (proven by the flag) AND received a signal value
    // — `module.close()` passes `undefined` (no signal). A real
    // SIGTERM-driven shutdown would carry the signal name.
    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.signalReceived).toBeUndefined();
  });
});
