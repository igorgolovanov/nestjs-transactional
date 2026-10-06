import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { OutboxRelay } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AccountService } from '../src/account.service.js';
import { AuditLoggingModule } from '../src/app.module.js';
import { AuditHandler } from '../src/audit.handler.js';
import { AccountOperationRow, AccountRow, AuditLogRow } from '../src/entities.js';
import { AccountOperationEvent } from '../src/events.js';

describe('audit-logging (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let businessDs: DataSource;
  let auditDs: DataSource;
  let accounts: AccountService;
  let audit: AuditHandler;
  let relay: OutboxRelay;

  const pending = async (): Promise<{ attempts: number; last_error: string | null }[]> =>
    businessDs.query('SELECT attempts, last_error FROM nest_outbox.messages ORDER BY seq');

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TransactionalTypeOrmModule.resetForTesting();

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
        AuditLoggingModule.forConfig(
          {
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
          },
          // Deliver with `relay.runOnce()`, so nothing races the assertions.
          { relay: false },
        ),
      ],
    }).compile();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    businessDs = module.get<DataSource>(getDataSourceToken());
    auditDs = module.get<DataSource>(getDataSourceToken('audit'));
    accounts = module.get(AccountService);
    audit = module.get(AuditHandler);
    relay = module.get(OutboxRelay);
  }, 120_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await businessDs.query('TRUNCATE nest_outbox.messages, nest_outbox.inbox');
    await businessDs.getRepository(AccountOperationRow).clear();
    await businessDs.getRepository(AccountRow).clear();
    await auditDs.getRepository(AuditLogRow).clear();
    // Seed an account that every test starts from.
    await businessDs.getRepository(AccountRow).insert({ id: 'acc-1', balance: 100 });
  });

  it('happy path: deposit commits balance + operation + message; the relay writes the audit row', async () => {
    await accounts.deposit('acc-1', 'op-1', 25);

    expect((await businessDs.getRepository(AccountRow).findOneBy({ id: 'acc-1' }))?.balance).toBe(
      125,
    );
    expect(await businessDs.getRepository(AccountOperationRow).countBy({ id: 'op-1' })).toBe(1);
    expect(await pending()).toHaveLength(1);

    await relay.runOnce();

    const row = await auditDs.getRepository(AuditLogRow).findOneBy({ operationId: 'op-1' });
    expect(row).toMatchObject({
      accountId: 'acc-1',
      type: 'deposit',
      amount: 25,
      balanceAfter: 125,
    });
    expect(await pending()).toEqual([]);
  });

  it('business rollback: overdraw throws; balance unchanged; no operation row; no message; no audit row', async () => {
    await expect(accounts.withdraw('acc-1', 'op-2', 9_999)).rejects.toThrow('insufficient');

    expect((await businessDs.getRepository(AccountRow).findOneBy({ id: 'acc-1' }))?.balance).toBe(
      100,
    );
    expect(await businessDs.getRepository(AccountOperationRow).countBy({ id: 'op-2' })).toBe(0);
    expect(await pending()).toEqual([]);

    await relay.runOnce();
    expect(await auditDs.getRepository(AuditLogRow).countBy({ operationId: 'op-2' })).toBe(0);
  });

  it('idempotent audit: a second delivery of the same operation does not duplicate the audit row', async () => {
    const event = new AccountOperationEvent('op-3', 'acc-1', 'deposit', 5, 105);

    await audit.log(event);
    await audit.log(event); // a redelivery that got past the inbox

    expect(await auditDs.getRepository(AuditLogRow).countBy({ operationId: 'op-3' })).toBe(1);
  });

  it('audit DS down: the business write commits, the message waits, and a retry writes the audit row', async () => {
    // Simulate the audit DS being unavailable by destroying its
    // connection pool. The audit transaction fails, so the relay keeps
    // the message and schedules a retry.
    await auditDs.destroy();

    // The business operation succeeds despite the audit outage, which is
    // the whole point of the cross-DS-via-outbox pattern.
    await accounts.deposit('acc-1', 'op-during-outage', 10);
    expect((await businessDs.getRepository(AccountRow).findOneBy({ id: 'acc-1' }))?.balance).toBe(
      110,
    );

    await relay.runOnce();
    const [waiting] = await pending();
    expect(waiting).toMatchObject({ attempts: 1 });
    expect(waiting!.last_error).toBeTruthy();

    // The audit DS comes back. Make the scheduled retry due now rather
    // than sleeping through the backoff, and let the relay deliver it.
    await auditDs.initialize();
    await businessDs.query('UPDATE nest_outbox.messages SET available_at = 0');
    await relay.runOnce();

    expect(
      await auditDs.getRepository(AuditLogRow).countBy({ operationId: 'op-during-outage' }),
    ).toBe(1);
    expect(await pending()).toEqual([]);
  });
});
