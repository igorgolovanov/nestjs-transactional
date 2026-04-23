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
import { OutboxDrainService } from '../src/shutdown/outbox-drain.service';

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
  let drain: OutboxDrainService;
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
    drain = module.get(OutboxDrainService);
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

    await module.close();

    expect(drain.drained).toBe(true);
    expect(drain.drainTimedOut).toBe(false);
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

    // The drain awaits the handler's remaining latency. Total close
    // time should be at least the handler latency (the handler
    // started before close() was invoked).
    expect(closeDuration).toBeGreaterThanOrEqual(HANDLER_LATENCY_MS / 2);

    // Handler finished cleanly — no row stuck in PROCESSING.
    expect(archival.finished).toBe(1);
    expect(drain.drained).toBe(true);

    // Verify via the side pg client (the Nest-managed DataSource is
    // already closed at this point).
    const result = await verifyClient.query<{ status: string }>(
      'SELECT status FROM event_publication',
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.status).toBe(PublicationStatus.COMPLETED);
  });

  it('preserves single-unit atomicity for a transaction completing concurrently with shutdown', async () => {
    // Kick off a recordEvent (writes audit_log + outbox publication
    // in one tx) and immediately request shutdown. Both should
    // settle: the tx commits, both rows persist, OnApplicationShutdown
    // hooks run, shutdown finishes.
    const recordPromise = audit.recordEvent('a-2', 'tx mid-shutdown');
    const closePromise = module.close();

    await Promise.all([recordPromise, closePromise]);

    // Tx committed atomically (DD-019) — both rows are present.
    const auditRows = await verifyClient.query<{ id: string }>(
      'SELECT id FROM audit_log',
    );
    expect(auditRows.rows.map((r) => r.id)).toEqual(['a-2']);

    const pubRows = await verifyClient.query<{ event_type: string }>(
      'SELECT event_type FROM event_publication',
    );
    expect(pubRows.rows).toHaveLength(1);
    expect(pubRows.rows[0]?.event_type).toBe('AuditEventRecordedEvent');

    // The hook chain still ran cleanly.
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
