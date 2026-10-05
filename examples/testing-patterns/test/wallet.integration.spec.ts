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

import { WalletProjection } from '../src/wallet.listener.js';
import { WalletModule } from '../src/wallet.module.js';
import { WalletRow } from '../src/wallet.entity.js';
import { WalletService } from '../src/wallet.service.js';

/**
 * **Tier 3: Integration tests via testcontainers Postgres.**
 *
 * Same `WalletService`, same `WalletProjection`, but now wired
 * against the **production** `WalletModule` — real Postgres, real
 * outbox tables, real relay. Slower (~2–10 s for the suite once
 * the image is cached) but exercises the parts the unit tiers
 * cannot: above all that the outbox message commits and rolls back
 * with the wallet row, which only the database can show.
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
  let relay: OutboxRelay;

  const pending = async (): Promise<number> =>
    Number((await ds.query('SELECT count(*) AS n FROM nest_outbox.messages'))[0].n);

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TransactionalTypeOrmModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    module = await Test.createTestingModule({
      imports: [
        WalletModule.forConfig(
          {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          },
          // Drive delivery with `relay.runOnce()` rather than waiting on
          // a background poll.
          { relay: false },
        ),
      ],
    }).compile();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    ds = module.get<DataSource>(getDataSourceToken());
    service = module.get(WalletService);
    projection = module.get(WalletProjection);
    relay = module.get(OutboxRelay);
  }, 90_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE nest_outbox.messages, nest_outbox.inbox');
    await ds.getRepository(WalletRow).clear();
    await ds.getRepository(WalletRow).insert({ id: 'w-1', balance: 100 });
    projection.invocations.length = 0;
  });

  it('happy path: deposit commits balance + message; the relay delivers it to the listener', async () => {
    await service.deposit('w-1', 25);

    expect((await ds.getRepository(WalletRow).findOneBy({ id: 'w-1' }))?.balance).toBe(125);
    expect(await pending()).toBe(1);

    await relay.runOnce();

    expect(projection.invocations.map((e) => e.balanceAfter)).toEqual([125]);
    expect(await pending()).toBe(0);
  });

  it('rollback: insufficient funds throws; balance unchanged; no message; listener not invoked', async () => {
    await expect(service.withdraw('w-1', 99_999)).rejects.toThrow('insufficient');

    expect((await ds.getRepository(WalletRow).findOneBy({ id: 'w-1' }))?.balance).toBe(100);
    expect(await pending()).toBe(0);

    await relay.runOnce();
    expect(projection.invocations).toHaveLength(0);
  });

  it('multiple deposits: each one reaches the projection', async () => {
    await service.deposit('w-1', 10);
    await service.deposit('w-1', 20);
    await service.deposit('w-1', 30);

    expect((await ds.getRepository(WalletRow).findOneBy({ id: 'w-1' }))?.balance).toBe(160);

    await relay.runOnce();
    expect(projection.invocations.map((e) => e.balanceAfter).sort((a, b) => a - b)).toEqual([
      110, 130, 160,
    ]);
  });
});
