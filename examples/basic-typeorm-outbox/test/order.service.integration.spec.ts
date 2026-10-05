import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { OutboxRelay } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { OrderEntity } from '../src/order.entity.js';
import { OrderService } from '../src/order.service.js';
import { ShippingHandler } from '../src/shipping.handler.js';

describe('basic-typeorm-outbox (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let orders: OrderService;
  let shipping: ShippingHandler;
  let relay: OutboxRelay;

  /** Messages still waiting in the outbox. */
  const pending = async (): Promise<{ topic: string }[]> =>
    dataSource.query('SELECT topic FROM nest_outbox.messages ORDER BY seq');

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    module = await Test.createTestingModule({
      imports: [
        AppModule.forPostgres(
          {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          },
          // The test drives the relay itself, so delivery happens exactly
          // when it calls `runOnce()` and never races an assertion.
          { relay: false },
        ),
      ],
    }).compile();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await module.init();

    dataSource = module.get<DataSource>(getDataSourceToken());
    orders = module.get(OrderService);
    shipping = module.get(ShippingHandler);
    relay = module.get(OutboxRelay);
  }, 120_000);

  afterAll(async () => {
    await module?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE nest_outbox.messages, nest_outbox.inbox');
    await dataSource.getRepository(OrderEntity).clear();
    shipping.handled.length = 0;
  });

  it('commits the order and its outbox message in one transaction', async () => {
    await orders.placeOrder('o-1', 'alice@example.com', 5_000);

    const orderRows = await dataSource.getRepository(OrderEntity).find();
    expect(orderRows.map((o) => o.id)).toEqual(['o-1']);
    expect(await pending()).toEqual([{ topic: 'OrderPlacedEvent' }]);
  });

  it('rolls back both when the @Transactional method throws', async () => {
    await expect(orders.placeOrderAndFail('o-2', 'bob@example.com', 7_500)).rejects.toThrow(
      'simulated failure after publish — both rows should roll back',
    );

    expect(await dataSource.getRepository(OrderEntity).find()).toHaveLength(0);
    expect(await pending()).toEqual([]);

    // Nothing to deliver, so the handler never sees it.
    await relay.runOnce();
    expect(shipping.handled).toEqual([]);
  });

  it('delivers to the @OnOutboxMessage handler and records it in its inbox', async () => {
    await orders.placeOrder('o-3', 'carol@example.com', 1_000);
    await orders.placeOrder('o-4', 'dave@example.com', 2_000);

    await relay.runOnce();

    expect(shipping.handled.map((e) => e.orderId).sort()).toEqual(['o-3', 'o-4']);
    expect(await pending()).toEqual([]);
    const inbox: { consumer: string }[] = await dataSource.query(
      'SELECT consumer FROM nest_outbox.inbox',
    );
    expect(inbox).toEqual([
      { consumer: 'shipping.create-shipment' },
      { consumer: 'shipping.create-shipment' },
    ]);
  });
});
