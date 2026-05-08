import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import {
  EventPublicationEntity,
  EventPublicationArchiveEntity,
} from '@nestjs-transactional/outbox-typeorm';
import { OutboxModule, PublicationStatus } from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { OrderEntity } from '../src/order.entity';
import { OrderService } from '../src/order.service';
import { ShippingHandler } from '../src/shipping.handler';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('basic-typeorm-outbox (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let orders: OrderService;
  let shipping: ShippingHandler;

  beforeAll(async () => {
    // Required when the same Node process re-imports the modules
    // across test files — static class storage in the modules dedups
    // dataSource registrations and would otherwise refuse the second
    // wiring.
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

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

    // Logger noise reduction — the outbox processor logs every poll.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await module.init();

    dataSource = module.get<DataSource>(getDataSourceToken());
    orders = module.get(OrderService);
    shipping = module.get(ShippingHandler);
  }, 60_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    // Drain residual state between tests — the worker may pick up
    // rows from prior test runs otherwise.
    await dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await dataSource.getRepository(EventPublicationEntity).clear();
    await dataSource.getRepository(OrderEntity).clear();
    shipping.handled.length = 0;
  });

  it('commits order INSERT and event_publication INSERT in the same transaction (atomicity)', async () => {
    await orders.placeOrder('o-1', 'alice@example.com', 5_000);

    // Both rows present after commit.
    const orderRows = await dataSource.getRepository(OrderEntity).find();
    const publicationRows = await dataSource.getRepository(EventPublicationEntity).find();

    expect(orderRows.map((o) => o.id)).toEqual(['o-1']);
    expect(publicationRows).toHaveLength(1);
    const [pub] = publicationRows;
    expect(pub?.eventType).toBe('OrderPlacedEvent');

    // Status starts PUBLISHED, transitions to COMPLETED once the
    // worker invokes ShippingHandler.handle.
    await waitFor(() => shipping.handled.some((e) => e.orderId === 'o-1'));

    const completed = await dataSource.getRepository(EventPublicationEntity).findOne({
      where: { id: pub!.id },
    });
    expect(completed?.status).toBe(PublicationStatus.COMPLETED);
  });

  it('rolls back BOTH rows when the @Transactional method throws', async () => {
    await expect(
      orders.placeOrderAndFail('o-2', 'bob@example.com', 7_500),
    ).rejects.toThrow('simulated failure after publish — both rows should roll back');

    // Single-unit atomicity (DD-019) — neither row exists.
    const orderRows = await dataSource.getRepository(OrderEntity).find();
    const publicationRows = await dataSource.getRepository(EventPublicationEntity).find();
    expect(orderRows).toHaveLength(0);
    expect(publicationRows).toHaveLength(0);

    // And the event is never delivered.
    await new Promise((r) => setTimeout(r, 300));
    expect(shipping.handled.find((e) => e.orderId === 'o-2')).toBeUndefined();
  });

  it('processes multiple successful orders independently', async () => {
    await orders.placeOrder('o-3', 'carol@example.com', 1_000);
    await orders.placeOrder('o-4', 'dave@example.com', 2_000);

    await waitFor(
      () =>
        shipping.handled.some((e) => e.orderId === 'o-3') &&
        shipping.handled.some((e) => e.orderId === 'o-4'),
    );

    const ids = shipping.handled.map((e) => e.orderId).sort();
    expect(ids).toEqual(['o-3', 'o-4']);

    const completedRows = await dataSource.getRepository(EventPublicationEntity).find();
    expect(completedRows).toHaveLength(2);
    expect(completedRows.every((r) => r.status === PublicationStatus.COMPLETED)).toBe(true);
  });
});
