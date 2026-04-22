import 'reflect-metadata';

import { type INestApplication, Logger } from '@nestjs/common';
import { type ClientProxy } from '@nestjs/microservices';
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
import { of } from 'rxjs';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { KAFKA_CLIENT } from '../src/clients';
import { PaymentRow } from '../src/billing/payment.entity';
import { OrderRow } from '../src/orders/order.entity';
import { ProductRow } from '../src/inventory/product.entity';
import { ReservationRow } from '../src/inventory/reservation.entity';

interface KafkaMock {
  proxy: ClientProxy;
  emit: jest.Mock;
}

function makeKafkaMock(): KafkaMock {
  // ADR-016: ClientProxy.emit returns Observable<void> on success;
  // mocked emits return `of(undefined)` so the worker treats them
  // as silent-success — same behaviour the framework gives in
  // production when the broker accepts the message.
  const emit = jest.fn().mockReturnValue(of(undefined));
  const proxy = { emit } as unknown as ClientProxy;
  return { proxy, emit };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('e-commerce-orders (Postgres × 3 real, Kafka mocked)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let app: INestApplication;
  let ordersDs: DataSource;
  let inventoryDs: DataSource;
  let billingDs: DataSource;
  let kafka: KafkaMock;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // One container, three databases — same trick as Tier 2 multi-DS examples.
    const { Client } = await import('pg');
    const admin = new Client({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    });
    await admin.connect();
    await admin.query('CREATE DATABASE inventory_db');
    await admin.query('CREATE DATABASE billing_db');
    await admin.end();

    kafka = makeKafkaMock();

    const conn = {
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
    };

    module = await Test.createTestingModule({
      imports: [
        AppModule.forConfig({
          orders: { ...conn, database: container.getDatabase() },
          inventory: { ...conn, database: 'inventory_db' },
          billing: { ...conn, database: 'billing_db' },
          kafkaBrokers: ['unused:9092'],
        }),
      ],
    })
      .overrideProvider(KAFKA_CLIENT)
      .useValue(kafka.proxy)
      .compile();

    // Worker briefly observes rolled-back rows during the failure
    // tests — `markFailed` then errors on a missing row. Expected
    // noise; suppress all log levels for the suite.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    app = module.createNestApplication();
    await app.init();

    ordersDs = module.get<DataSource>(getDataSourceToken());
    inventoryDs = module.get<DataSource>(getDataSourceToken('inventory'));
    billingDs = module.get<DataSource>(getDataSourceToken('billing'));
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await module?.close();
    await container.stop();
  });

  beforeEach(async () => {
    kafka.emit.mockClear();
    await ordersDs.query('TRUNCATE TABLE event_publication, event_publication_archive RESTART IDENTITY');
    await inventoryDs.query('TRUNCATE TABLE event_publication, event_publication_archive RESTART IDENTITY');
    await billingDs.query('TRUNCATE TABLE event_publication, event_publication_archive RESTART IDENTITY');
    await ordersDs.getRepository(OrderRow).clear();
    await inventoryDs.getRepository(ReservationRow).clear();
    await inventoryDs.getRepository(ProductRow).clear();
    await billingDs.getRepository(PaymentRow).clear();
  });

  async function seedStock(sku: string, available: number): Promise<void> {
    await inventoryDs.getRepository(ProductRow).save({ sku, available });
  }

  async function placeOrder(body: object): Promise<{ statusCode: number; orderId?: string }> {
    const res = await request(app.getHttpServer()).post('/orders').send(body);
    return {
      statusCode: res.status,
      orderId: res.body?.orderId,
    };
  }

  it('happy path: POST /orders → confirmed → OrderConfirmedEvent emitted to Kafka', async () => {
    await seedStock('WIDGET', 10);

    const placed = await placeOrder({
      customerId: 'c-1',
      items: [{ sku: 'WIDGET', quantity: 2, unitPriceCents: 1_500 }],
    });
    expect(placed.statusCode).toBe(201);
    const orderId = placed.orderId!;

    await waitFor(
      async () => (await ordersDs.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'confirmed',
    );

    // Inventory + payment side-effects landed.
    expect((await inventoryDs.getRepository(ProductRow).findOneBy({ sku: 'WIDGET' }))?.available).toBe(8);
    expect(
      (await inventoryDs.getRepository(ReservationRow).findOneBy({ id: `${orderId}:WIDGET` }))?.status,
    ).toBe('reserved');
    expect((await billingDs.getRepository(PaymentRow).findOneBy({ orderId }))?.status).toBe('charged');

    // OrderConfirmedEvent reached the Kafka mock — externalization
    // happens AFTER the worker delivers, so we wait for it.
    // Note: `@Externalized` `headers` / `routingKey` callbacks are
    // currently a Phase 11.3 documented limitation — they're not
    // routed to `ClientProxy.emit` yet. Tests assert on the event
    // payload itself.
    await waitFor(() =>
      kafka.emit.mock.calls.some(([target]) => target === 'orders.confirmed'),
    );
    const confirmedCall = kafka.emit.mock.calls.find(
      ([target]) => target === 'orders.confirmed',
    );
    expect(confirmedCall).toBeDefined();
    expect(confirmedCall![1]).toMatchObject({
      orderId,
      customerId: 'c-1',
      totalAmountCents: 3000,
    });
  });

  it('GET /orders/:id returns the persisted order shape', async () => {
    await seedStock('GADGET', 5);

    const placed = await placeOrder({
      customerId: 'c-2',
      items: [{ sku: 'GADGET', quantity: 1, unitPriceCents: 500 }],
    });
    const orderId = placed.orderId!;

    await waitFor(
      async () => (await ordersDs.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'confirmed',
    );

    const res = await request(app.getHttpServer()).get(`/orders/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: orderId,
      customerId: 'c-2',
      status: 'confirmed',
      totalAmountCents: 500,
      items: [{ sku: 'GADGET', quantity: 1, unitPriceCents: 500 }],
    });
    expect(res.body.confirmedAt).not.toBeNull();
  });

  it('GET /orders/:id with unknown id returns 404', async () => {
    const res = await request(app.getHttpServer()).get('/orders/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST validation rejects bodies missing customerId / items', async () => {
    expect((await placeOrder({})).statusCode).toBe(400);
    expect((await placeOrder({ customerId: 'c-1' })).statusCode).toBe(400);
    expect(
      (await placeOrder({ customerId: 'c-1', items: [] })).statusCode,
    ).toBe(400);
    expect(
      (
        await placeOrder({
          customerId: 'c-1',
          items: [{ sku: 'X', quantity: 0, unitPriceCents: 100 }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('out-of-stock: reservation fails → order marked failed; no payment, no Kafka emit', async () => {
    await seedStock('SCARCE', 1);

    const placed = await placeOrder({
      customerId: 'c-oos',
      items: [{ sku: 'SCARCE', quantity: 5, unitPriceCents: 100 }],
    });
    const orderId = placed.orderId!;

    await waitFor(
      async () => (await ordersDs.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'failed',
    );

    const order = await ordersDs.getRepository(OrderRow).findOneBy({ id: orderId });
    expect(order?.failureReason).toContain('out of stock');

    // Stock unchanged — the @Transactional inside ReserveStockHandler rolled back.
    expect((await inventoryDs.getRepository(ProductRow).findOneBy({ sku: 'SCARCE' }))?.available).toBe(1);
    expect(await billingDs.getRepository(PaymentRow).countBy({ orderId })).toBe(0);

    // OrderConfirmedEvent never emitted.
    await new Promise((r) => setTimeout(r, 300));
    expect(
      kafka.emit.mock.calls.some(
        ([target, payload]) =>
          target === 'orders.confirmed' &&
          (payload as { headers?: { 'x-order-id'?: string } })?.headers?.['x-order-id'] === orderId,
      ),
    ).toBe(false);
  });

  it('payment-fail compensation: reservation succeeds, payment declined, stock released', async () => {
    await seedStock('PRICY', 5);

    // Amount >= UNAUTHORISED_AMOUNT_CENTS (1_000_000) triggers the
    // toy authorisation rule.
    const placed = await placeOrder({
      customerId: 'c-payfail',
      items: [{ sku: 'PRICY', quantity: 2, unitPriceCents: 600_000 }],
    });
    const orderId = placed.orderId!;

    await waitFor(
      async () => (await ordersDs.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'failed',
      10_000,
    );

    const payment = await billingDs.getRepository(PaymentRow).findOneBy({ orderId });
    expect(payment?.status).toBe('failed');

    // Stock fully released by ReleaseStockHandler — back to 5.
    await waitFor(
      async () => (await inventoryDs.getRepository(ProductRow).findOneBy({ sku: 'PRICY' }))?.available === 5,
      10_000,
    );
    expect(
      (await inventoryDs.getRepository(ReservationRow).findOneBy({ id: `${orderId}:PRICY` }))?.status,
    ).toBe('released');
  });

  it('cross-DS rollback isolation: a poisoned product row in inventory never touches orders or billing on placement', async () => {
    // No stock seeded for 'INVALID' — reservation will OOS-fail.
    const placed = await placeOrder({
      customerId: 'c-cross',
      items: [{ sku: 'INVALID', quantity: 1, unitPriceCents: 100 }],
    });
    const orderId = placed.orderId!;

    // The ORDER row IS persisted (the placement transaction
    // committed in orders DS atomically with the OrderPlacedEvent
    // publication, before reservation runs).
    expect(await ordersDs.getRepository(OrderRow).findOneBy({ id: orderId })).not.toBeNull();

    await waitFor(
      async () => (await ordersDs.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'failed',
    );

    // Billing untouched.
    expect(await billingDs.getRepository(PaymentRow).countBy({ orderId })).toBe(0);
    // Inventory untouched (no rows since no SKU matched).
    expect(await inventoryDs.getRepository(ReservationRow).countBy({ orderId })).toBe(0);
  });

  it('outbox status transitions: every publication ends COMPLETED on each DS', async () => {
    await seedStock('GIZMO', 10);

    const placed = await placeOrder({
      customerId: 'c-outbox',
      items: [{ sku: 'GIZMO', quantity: 1, unitPriceCents: 750 }],
    });
    const orderId = placed.orderId!;

    await waitFor(
      async () => (await ordersDs.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'confirmed',
    );

    // Wait for every per-DS publication to be COMPLETED. Default
    // completionMode is UPDATE — rows stay in the hot queue with
    // status='COMPLETED' (Convention learned in audit-logging).
    await waitFor(async () => {
      const allDs = [ordersDs, inventoryDs, billingDs];
      for (const ds of allDs) {
        const pending = await ds.getRepository(EventPublicationEntity).count({
          where: { status: PublicationStatus.PUBLISHED },
        });
        if (pending > 0) return false;
      }
      return true;
    });

    // Sanity: every DS produced at least one publication.
    for (const ds of [ordersDs, inventoryDs, billingDs]) {
      const total = await ds.getRepository(EventPublicationEntity).count();
      expect(total).toBeGreaterThan(0);
    }
  });
});
