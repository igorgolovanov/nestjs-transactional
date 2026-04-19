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

import { WalletProjection } from '../src/wallet.listener';
import { WalletModule } from '../src/wallet.module';
import { WalletRow } from '../src/wallet.entity';
import { WalletService } from '../src/wallet.service';

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * **Tier 3: Integration tests via testcontainers Postgres.**
 *
 * Same `WalletService`, same `WalletProjection`, but now wired
 * against the **production** `WalletModule` — real Postgres, real
 * outbox tables, real worker. Slower (~2–10 s for the suite once
 * the image is cached) but exercises the parts the unit tiers
 * cannot: row-level isolation, the worker poll loop, status
 * transitions on the publication row.
 *
 * Trade-off: any one of these tests catches significantly more
 * regressions than its unit-tier counterpart, and you should keep
 * a healthy ratio of both. Unit tests for branch coverage and
 * fast-iteration; integration tests for end-to-end invariants.
 */
describe('WalletService (integration, testcontainers Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let ds: DataSource;
  let service: WalletService;
  let projection: WalletProjection;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    module = await Test.createTestingModule({
      imports: [
        WalletModule.forConfig({
          host: container.getHost(),
          port: container.getPort(),
          username: container.getUsername(),
          password: container.getPassword(),
          database: container.getDatabase(),
        }),
      ],
    }).compile();

    // Worker briefly observes rolled-back rows during the rollback
    // test — its `markFailed` then errors on a missing row. Expected
    // noise; suppress all log levels for the suite.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    ds = module.get<DataSource>(getDataSourceToken());
    service = module.get(WalletService);
    projection = module.get(WalletProjection);
  }, 90_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE TABLE event_publication, event_publication_archive RESTART IDENTITY');
    await ds.getRepository(WalletRow).clear();
    await ds.getRepository(WalletRow).insert({ id: 'w-1', balance: 100 });
    projection.invocations.length = 0;
  });

  it('happy path: deposit commits balance + publication; listener fires after worker delivery', async () => {
    await service.deposit('w-1', 25);

    expect((await ds.getRepository(WalletRow).findOneBy({ id: 'w-1' }))?.balance).toBe(125);

    // Outbox-routed listener — delivery is asynchronous via the
    // worker, so we wait for it.
    await waitFor(() => projection.invocations.length === 1);
    expect(projection.invocations[0]?.balanceAfter).toBe(125);

    // Publication transitions to COMPLETED once the worker has
    // invoked the listener and the post-handler bookkeeping runs.
    await waitFor(async () => {
      const pub = await ds.getRepository(EventPublicationEntity).findOne({
        where: { eventType: 'WalletOperationEvent' },
      });
      return pub?.status === PublicationStatus.COMPLETED;
    });
  });

  it('rollback: insufficient funds throws; balance unchanged; no publication; listener not invoked', async () => {
    await expect(service.withdraw('w-1', 99_999)).rejects.toThrow('insufficient');

    // Brief wait — give the worker a chance to misbehave if the
    // publication leaked.
    await new Promise((r) => setTimeout(r, 200));

    expect((await ds.getRepository(WalletRow).findOneBy({ id: 'w-1' }))?.balance).toBe(100);
    expect(
      await ds
        .getRepository(EventPublicationEntity)
        .countBy({ eventType: 'WalletOperationEvent' }),
    ).toBe(0);
    expect(projection.invocations).toHaveLength(0);
  });

  it('multiple deposits: ordering visible in projection', async () => {
    await service.deposit('w-1', 10);
    await service.deposit('w-1', 20);
    await service.deposit('w-1', 30);

    expect((await ds.getRepository(WalletRow).findOneBy({ id: 'w-1' }))?.balance).toBe(160);

    await waitFor(() => projection.invocations.length === 3);
    expect(projection.invocations.map((e) => e.balanceAfter).sort((a, b) => a - b)).toEqual([
      110, 130, 160,
    ]);
  });
});
