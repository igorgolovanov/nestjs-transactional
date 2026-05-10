import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule } from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { OrderRow, PaymentRow, ReservationRow, StockItemRow } from '../src/entities';
import { OrderPlacedEvent } from '../src/events';
import { OrderService } from '../src/order.service';
import { ReservationHandler } from '../src/reservation.handler';

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('saga-pattern (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let ds: DataSource;
  let orders: OrderService;
  let reservation: ReservationHandler;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    module = await Test.createTestingModule({
      imports: [
        AppModule.forConfig({
          host: container.getHost(),
          port: container.getPort(),
          username: container.getUsername(),
          password: container.getPassword(),
          database: container.getDatabase(),
        }),
      ],
    }).compile();

    // Worker briefly observes rolled-back rows during the atomicity
    // test below — its `markFailed` then errors on a missing row.
    // Expected noise; suppress all log levels for the suite.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    ds = module.get<DataSource>(getDataSourceToken());
    orders = module.get(OrderService);
    reservation = module.get(ReservationHandler);
  }, 90_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE TABLE event_publication, event_publication_archive RESTART IDENTITY');
    await ds.getRepository(PaymentRow).clear();
    await ds.getRepository(ReservationRow).clear();
    await ds.getRepository(OrderRow).clear();
    await ds.getRepository(StockItemRow).clear();
  });

  async function seedStock(sku: string, available: number): Promise<void> {
    await ds.getRepository(StockItemRow).save({ sku, available });
  }

  it('happy path: place → reserve → charge → ship; stock decremented; payment recorded', async () => {
    await seedStock('WIDGET', 5);

    await orders.placeOrder('ord-happy', 'WIDGET', 2, 100);

    await waitFor(async () => (await ds.getRepository(OrderRow).findOneBy({ id: 'ord-happy' }))?.status === 'shipped');

    expect((await ds.getRepository(StockItemRow).findOneBy({ sku: 'WIDGET' }))?.available).toBe(3);
    expect((await ds.getRepository(ReservationRow).findOneBy({ orderId: 'ord-happy' }))?.quantity).toBe(2);
    expect((await ds.getRepository(PaymentRow).findOneBy({ orderId: 'ord-happy' }))?.status).toBe('charged');
  });

  it('payment-failure path: charge fails → compensation restores stock and marks order failed-payment', async () => {
    await seedStock('WIDGET', 5);

    await orders.placeOrder('ord-payfail', 'WIDGET', 2, 12_000);

    await waitFor(
      async () => (await ds.getRepository(OrderRow).findOneBy({ id: 'ord-payfail' }))?.status === 'failed-payment',
    );

    // Stock fully restored — reservation decremented by 2, compensation added 2 back.
    expect((await ds.getRepository(StockItemRow).findOneBy({ sku: 'WIDGET' }))?.available).toBe(5);
    // Payment row records the failure (created atomically with the failure event).
    expect((await ds.getRepository(PaymentRow).findOneBy({ orderId: 'ord-payfail' }))?.status).toBe('failed');
  });

  it('reservation-failure path: out of stock → no payment, stock unchanged, order failed-reservation', async () => {
    await seedStock('WIDGET', 1);

    await orders.placeOrder('ord-oos', 'WIDGET', 5, 100);

    await waitFor(
      async () =>
        (await ds.getRepository(OrderRow).findOneBy({ id: 'ord-oos' }))?.status === 'failed-reservation',
    );

    expect((await ds.getRepository(StockItemRow).findOneBy({ sku: 'WIDGET' }))?.available).toBe(1);
    // No payment row — payment handler never received `InventoryReservedEvent`.
    expect(await ds.getRepository(PaymentRow).findOneBy({ orderId: 'ord-oos' })).toBeNull();
  });

  it('idempotent step: re-invoking the reservation handler with the same event does not double-decrement stock', async () => {
    // This test calls the handler directly to simulate the outbox
    // worker's at-least-once retry. The handler is @Transactional and
    // its primary-key INSERT into `reservations` throws unique_violation
    // on the second run — caught by the handler as the idempotency
    // gate. Stock is decremented exactly once; no second
    // `InventoryReservedEvent` is published; the saga proceeds normally
    // through the first run's chain.
    await seedStock('WIDGET', 5);

    // Seed an order row directly so the handler's `orders.update` finds it.
    await ds.getRepository(OrderRow).insert({
      id: 'ord-retry',
      sku: 'WIDGET',
      quantity: 2,
      amount: 100,
      status: 'placed',
    });

    const event = new OrderPlacedEvent('ord-retry', 'WIDGET', 2, 100);

    await reservation.handle(event);
    await reservation.handle(event); // simulated outbox retry

    // Stock decremented exactly once.
    expect((await ds.getRepository(StockItemRow).findOneBy({ sku: 'WIDGET' }))?.available).toBe(3);
    // Reservation row exists with the original quantity.
    expect((await ds.getRepository(ReservationRow).findOneBy({ orderId: 'ord-retry' }))?.quantity).toBe(2);
  });

  it('atomicity at saga entry: a duplicate placeOrder fails, no second OrderPlacedEvent is published, no second saga runs', async () => {
    await seedStock('WIDGET', 5);

    await orders.placeOrder('ord-dup', 'WIDGET', 1, 100);
    await waitFor(async () => (await ds.getRepository(OrderRow).findOneBy({ id: 'ord-dup' }))?.status === 'shipped');

    const stockAfterFirst = (await ds.getRepository(StockItemRow).findOneBy({ sku: 'WIDGET' }))?.available;

    // Second call with the same orderId — INSERT fails on the orders
    // PK, the @Transactional rolls back, and the OrderPlacedEvent
    // publication that was being scheduled for this transaction is
    // discarded too (DD-019). No second saga ever runs.
    await expect(orders.placeOrder('ord-dup', 'WIDGET', 1, 100)).rejects.toThrow();

    // Give the worker a moment in case anything stray landed.
    await new Promise((r) => setTimeout(r, 300));

    // Stock unchanged from the first run.
    expect((await ds.getRepository(StockItemRow).findOneBy({ sku: 'WIDGET' }))?.available).toBe(stockAfterFirst);
    // Still exactly one reservation and one payment.
    expect(await ds.getRepository(ReservationRow).count()).toBe(1);
    expect(await ds.getRepository(PaymentRow).count()).toBe(1);
  });
});
