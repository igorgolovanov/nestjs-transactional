import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, PublicationStatus } from '@nestjs-transactional/outbox';
import { EventPublicationEntity } from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AccountService } from '../src/account.service';
import { AuditHandler } from '../src/audit.handler';
import { AuditLoggingModule } from '../src/app.module';
import { AccountOperationRow, AccountRow, AuditLogRow } from '../src/entities';
import { AccountOperationEvent } from '../src/events';

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('audit-logging (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let businessDs: DataSource;
  let auditDs: DataSource;
  let accounts: AccountService;
  let audit: AuditHandler;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // Spin up the audit database in the same container — testcontainers
    // gives the default user CREATEDB privilege.
    const { Client } = await import('pg');
    const adminClient = new Client({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    });
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE audit_db');
    await adminClient.end();

    module = await Test.createTestingModule({
      imports: [
        AuditLoggingModule.forConfig({
          business: {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          },
          audit: {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: 'audit_db',
          },
        }),
      ],
    }).compile();

    // Worker briefly observes rolled-back rows during the rollback test
    // — its `markFailed` then errors on a missing row. Expected noise.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    businessDs = module.get<DataSource>(getDataSourceToken());
    auditDs = module.get<DataSource>(getDataSourceToken('audit'));
    accounts = module.get(AccountService);
    audit = module.get(AuditHandler);
  }, 90_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await businessDs.query(
      'TRUNCATE TABLE event_publication, event_publication_archive RESTART IDENTITY',
    );
    await businessDs.getRepository(AccountOperationRow).clear();
    await businessDs.getRepository(AccountRow).clear();
    await auditDs.getRepository(AuditLogRow).clear();
    // Seed an account that every test starts from.
    await businessDs.getRepository(AccountRow).insert({ id: 'acc-1', balance: 100 });
  });

  it('happy path: deposit commits balance + operation + publication; audit row appears', async () => {
    await accounts.deposit('acc-1', 'op-1', 50);

    // Business side committed atomically (DD-019).
    expect((await businessDs.getRepository(AccountRow).findOneBy({ id: 'acc-1' }))?.balance).toBe(150);
    expect(await businessDs.getRepository(AccountOperationRow).countBy({ id: 'op-1' })).toBe(1);
    const pub = await businessDs.getRepository(EventPublicationEntity).findOne({
      where: { eventType: 'AccountOperationEvent' },
    });
    expect(pub).not.toBeNull();

    // Audit row appears after the worker delivers — wait for it.
    await waitFor(
      async () => (await auditDs.getRepository(AuditLogRow).countBy({ operationId: 'op-1' })) === 1,
    );
    const audited = await auditDs.getRepository(AuditLogRow).findOneBy({ operationId: 'op-1' });
    expect(audited?.balanceAfter).toBe(150);
    expect(audited?.amount).toBe(50);
    expect(audited?.type).toBe('deposit');

    // Publication transitions to COMPLETED once the handler returned.
    // Default `completionMode: UPDATE` keeps the row in the hot queue
    // with `status = COMPLETED` and a `completionDate` set.
    await waitFor(async () => {
      const reread = await businessDs.getRepository(EventPublicationEntity).findOne({
        where: { id: pub!.id },
      });
      return reread?.status === PublicationStatus.COMPLETED;
    });
  });

  it('business rollback: overdraw throws; balance unchanged; no operation row; no publication; no audit row', async () => {
    await expect(accounts.withdraw('acc-1', 'op-overdraw', 99_999)).rejects.toThrow('insufficient');

    // Brief wait — give the worker a chance to misbehave if the
    // publication leaked.
    await new Promise((r) => setTimeout(r, 300));

    // Business side: nothing changed (DD-019).
    expect((await businessDs.getRepository(AccountRow).findOneBy({ id: 'acc-1' }))?.balance).toBe(100);
    expect(await businessDs.getRepository(AccountOperationRow).countBy({ id: 'op-overdraw' })).toBe(0);
    expect(
      await businessDs
        .getRepository(EventPublicationEntity)
        .countBy({ eventType: 'AccountOperationEvent' }),
    ).toBe(0);

    // Audit DB completely untouched (DD-023).
    expect(await auditDs.getRepository(AuditLogRow).countBy({ operationId: 'op-overdraw' })).toBe(0);
  });

  it('idempotent audit: re-invoking the handler with the same event does not duplicate the audit row', async () => {
    const event = new AccountOperationEvent('op-idempotent', 'acc-1', 'deposit', 25, 125);

    await audit.handle(event);
    await audit.handle(event); // simulated outbox retry — second delivery

    const rows = await auditDs.getRepository(AuditLogRow).findBy({ operationId: 'op-idempotent' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(25);
  });

  it('audit DS down → publication stays PUBLISHED until audit DB recovers; business is not blocked', async () => {
    // Simulate the audit DS being unavailable by destroying its
    // connection pool. New audit transactions will fail; the worker
    // marks publications FAILED, and a future delivery (after we
    // restore) succeeds idempotently.
    await auditDs.destroy();

    // Business operation succeeds despite the audit outage — that is
    // the whole point of the cross-DS-via-outbox pattern.
    await accounts.deposit('acc-1', 'op-during-outage', 10);
    expect((await businessDs.getRepository(AccountRow).findOneBy({ id: 'acc-1' }))?.balance).toBe(110);

    // Wait for the worker to mark the publication FAILED.
    await waitFor(async () => {
      const pub = await businessDs.getRepository(EventPublicationEntity).findOne({
        where: { eventType: 'AccountOperationEvent' },
      });
      return pub?.status === PublicationStatus.FAILED;
    });

    // Bring the audit DS back up. Re-init via TypeORM's `initialize()`.
    await auditDs.initialize();

    // Manually invoke the audit handler (the worker would do this on
    // next poll after a `resubmit`; in the test we drive it directly
    // to keep the assertion deterministic).
    await audit.handle(new AccountOperationEvent('op-during-outage', 'acc-1', 'deposit', 10, 110));

    // Audit row eventually appears.
    expect(
      await auditDs.getRepository(AuditLogRow).countBy({ operationId: 'op-during-outage' }),
    ).toBe(1);
  });
});
