import 'reflect-metadata';

import { jest } from '@jest/globals';
import { type INestApplication, Logger } from '@nestjs/common';
import { type ClientProxy } from '@nestjs/microservices';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { of } from 'rxjs';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { KAFKA_CLIENT } from '../src/clients.js';
import { PaymentRow } from '../src/billing/payment.entity.js';
import { OrderRow } from '../src/orders/order.entity.js';
import { ProductRow } from '../src/inventory/product.entity.js';
import { ReservationRow } from '../src/inventory/reservation.entity.js';

interface KafkaMock {
  proxy: ClientProxy;
  emit: jest.Mock;
}

function makeKafkaMock(): KafkaMock {
  // `ClientProxy.emit` returns an Observable that completes on
  // success, so a mocked `of(undefined)` is exactly what the relay
  // sees when a real broker accepts the message.
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

describe('e-commerce-orders (Postgres real, Kafka recorded)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let app: INestApplication;
  let ds: DataSource;
  let kafka: KafkaMock;

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TransactionalTypeOrmModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    kafka = makeKafkaMock();

    module = await Test.createTestingModule({
      imports: [
        AppModule.forConfig({
          postgres: {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          },
          kafkaBrokers: ['unused:9092'],
        }),
      ],
    })
      .overrideProvider(KAFKA_CLIENT)
      .useValue(kafka.proxy)
      .compile();

    // The relay runs in the background: a saga is a chain of
    // deliveries, and each test waits for its end state.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    app = module.createNestApplication();
    await app.init();

    ds = module.get<DataSource>(getDataSourceToken());
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await module?.close();
    await container.stop();
  });

  beforeEach(async () => {
    kafka.emit.mockClear();
    await ds.query('TRUNCATE nest_outbox.messages, nest_outbox.dead_letters, nest_outbox.inbox');
    await ds.getRepository(OrderRow).clear();
    await ds.getRepository(ReservationRow).clear();
    await ds.getRepository(ProductRow).clear();
    await ds.getRepository(PaymentRow).clear();
  });

  async function seedStock(sku: string, available: number): Promise<void> {
    await ds.getRepository(ProductRow).save({ sku, available });
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
      async () =>
        (await ds.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'confirmed',
    );

    // Inventory + payment side-effects landed.
    expect((await ds.getRepository(ProductRow).findOneBy({ sku: 'WIDGET' }))?.available).toBe(8);
    expect(
      (await ds.getRepository(ReservationRow).findOneBy({ id: `${orderId}:WIDGET` }))?.status,
    ).toBe('reserved');
    expect((await ds.getRepository(PaymentRow).findOneBy({ orderId }))?.status).toBe('charged');

    // OrderConfirmedEvent reached Kafka as a keyed record: the relay
    // delivers it after the confirming transaction commits.
    await waitFor(() => kafka.emit.mock.calls.some(([target]) => target === 'orders.confirmed'));
    const confirmedCall = kafka.emit.mock.calls.find(([target]) => target === 'orders.confirmed');
    expect(confirmedCall).toBeDefined();
    const record = confirmedCall![1] as {
      key: string;
      headers: Record<string, string>;
      value: { payload: unknown };
    };
    expect(record.key).toBe(orderId);
    expect(record.headers).toMatchObject({ 'x-order-id': orderId, 'x-customer-id': 'c-1' });
    expect(record.value.payload).toMatchObject({
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
      async () =>
        (await ds.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'confirmed',
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
    expect((await placeOrder({ customerId: 'c-1', items: [] })).statusCode).toBe(400);
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
      async () =>
        (await ds.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'failed',
    );

    const order = await ds.getRepository(OrderRow).findOneBy({ id: orderId });
    expect(order?.failureReason).toContain('out of stock');

    // Stock unchanged — the @Transactional inside ReserveStockHandler rolled back.
    expect((await ds.getRepository(ProductRow).findOneBy({ sku: 'SCARCE' }))?.available).toBe(1);
    expect(await ds.getRepository(PaymentRow).countBy({ orderId })).toBe(0);

    // OrderConfirmedEvent never emitted.
    await new Promise((r) => setTimeout(r, 300));
    expect(
      kafka.emit.mock.calls.some(
        ([target, payload]) =>
          target === 'orders.confirmed' && (payload as { key?: string })?.key === orderId,
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
      async () =>
        (await ds.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'failed',
      10_000,
    );

    const payment = await ds.getRepository(PaymentRow).findOneBy({ orderId });
    expect(payment?.status).toBe('failed');

    // Stock fully released by ReleaseStockHandler — back to 5.
    await waitFor(
      async () => (await ds.getRepository(ProductRow).findOneBy({ sku: 'PRICY' }))?.available === 5,
      10_000,
    );
    expect(
      (await ds.getRepository(ReservationRow).findOneBy({ id: `${orderId}:PRICY` }))?.status,
    ).toBe('released');
  });

  it('context isolation: an unknown product fails the reservation without touching billing', async () => {
    // No stock seeded for 'INVALID' — reservation will OOS-fail.
    const placed = await placeOrder({
      customerId: 'c-cross',
      items: [{ sku: 'INVALID', quantity: 1, unitPriceCents: 100 }],
    });
    const orderId = placed.orderId!;

    // The order row IS persisted: the placement transaction committed
    // it together with the OrderPlacedEvent message, before reservation
    // runs.
    expect(await ds.getRepository(OrderRow).findOneBy({ id: orderId })).not.toBeNull();

    await waitFor(
      async () =>
        (await ds.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'failed',
    );

    // Billing untouched.
    expect(await ds.getRepository(PaymentRow).countBy({ orderId })).toBe(0);
    // Inventory untouched (no rows since no SKU matched).
    expect(await ds.getRepository(ReservationRow).countBy({ orderId })).toBe(0);
  });

  it('the outbox drains: every saga message is delivered, none dead-lettered', async () => {
    await seedStock('GIZMO', 10);

    const placed = await placeOrder({
      customerId: 'c-outbox',
      items: [{ sku: 'GIZMO', quantity: 1, unitPriceCents: 750 }],
    });
    const orderId = placed.orderId!;

    await waitFor(
      async () =>
        (await ds.getRepository(OrderRow).findOneBy({ id: orderId }))?.status === 'confirmed',
    );

    // Delivered messages leave the outbox; wait until none is waiting.
    await waitFor(async () => {
      const [{ n }] = await ds.query('SELECT count(*)::int AS n FROM nest_outbox.messages');
      return n === 0;
    });
    const [{ dead }] = await ds.query('SELECT count(*)::int AS dead FROM nest_outbox.dead_letters');
    expect(dead).toBe(0);

    // Each step recorded its delivery in its own inbox.
    const consumers: { consumer: string }[] = await ds.query(
      'SELECT DISTINCT consumer FROM nest_outbox.inbox ORDER BY consumer',
    );
    expect(consumers.map((c) => c.consumer)).toEqual([
      'billing.charge-payment',
      'inventory.reserve-stock',
      'orders.confirm-shipment',
    ]);
  });
});
