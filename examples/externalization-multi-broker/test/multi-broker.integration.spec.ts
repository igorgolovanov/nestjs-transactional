import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { type ClientProxy } from '@nestjs/microservices';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, PublicationStatus } from '@nestjs-transactional/outbox';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { of } from 'rxjs';
import type { DataSource } from 'typeorm';

import { AccountingHandler } from '../src/accounting.handler';
import { AppModule } from '../src/app.module';
import { KAFKA_CLIENT, RABBITMQ_CLIENT, REDIS_CLIENT } from '../src/clients';
import { LocalCacheInvalidator } from '../src/local-cache.handler';
import { OrderEntity } from '../src/order.entity';
import { OrderService } from '../src/order.service';
import { ShippingHandler } from '../src/shipping.handler';

interface ProxyMock {
  proxy: ClientProxy;
  emit: jest.Mock;
}

function makeProxy(): ProxyMock {
  const emit = jest.fn().mockReturnValue(of(undefined));
  const proxy = { emit } as unknown as ClientProxy;
  return { proxy, emit };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('externalization-multi-broker (Postgres real, three ClientProxy mocked)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let orders: OrderService;
  let shipping: ShippingHandler;
  let accounting: AccountingHandler;
  let cache: LocalCacheInvalidator;
  let kafka: ProxyMock;
  let rabbitmq: ProxyMock;
  let redis: ProxyMock;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    kafka = makeProxy();
    rabbitmq = makeProxy();
    redis = makeProxy();

    module = await Test.createTestingModule({
      imports: [
        AppModule.forInfrastructure(
          {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          },
          {
            kafkaBrokers: ['unused'],
            rabbitmqUrl: 'amqp://unused',
            redisHost: 'unused',
            redisPort: 0,
          },
        ),
      ],
    })
      .overrideProvider(KAFKA_CLIENT)
      .useValue(kafka.proxy)
      .overrideProvider(RABBITMQ_CLIENT)
      .useValue(rabbitmq.proxy)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis.proxy)
      .compile();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await module.init();

    dataSource = module.get<DataSource>(getDataSourceToken());
    orders = module.get(OrderService);
    shipping = module.get(ShippingHandler);
    accounting = module.get(AccountingHandler);
    cache = module.get(LocalCacheInvalidator);
  }, 60_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await dataSource.getRepository(EventPublicationEntity).clear();
    await dataSource.getRepository(OrderEntity).clear();
    shipping.handled.length = 0;
    accounting.handled.length = 0;
    cache.handled.length = 0;
    kafka.emit.mockClear();
    rabbitmq.emit.mockClear();
    redis.emit.mockClear();
  });

  it('routes OrderPlacedEvent to Kafka ONLY (not RabbitMQ, not Redis)', async () => {
    await orders.placeOrder('o-1', 'alice@example.com', 5_000);
    // No refund → no RefundRequestedEvent.

    await waitFor(() => shipping.handled.some((e) => e.orderId === 'o-1'));
    await waitFor(() => kafka.emit.mock.calls.length >= 1);
    // Cache invalidation always fires.
    await waitFor(() => cache.handled.some((e) => e.key.includes('alice@example.com')));

    expect(kafka.emit).toHaveBeenCalledTimes(1);
    expect(kafka.emit).toHaveBeenCalledWith(
      'orders.placed',
      expect.objectContaining({ orderId: 'o-1' }),
    );

    expect(rabbitmq.emit).not.toHaveBeenCalled();

    // Cache invalidation event always fires for `placeOrder` — Redis emit
    // gets exactly one call.
    expect(redis.emit).toHaveBeenCalledTimes(1);
    expect(redis.emit).toHaveBeenCalledWith(
      'cache.invalidated',
      expect.objectContaining({ key: 'customer:alice@example.com:pricing' }),
    );
  });

  it('routes RefundRequestedEvent to RabbitMQ ONLY (not Kafka, not Redis)', async () => {
    await orders.placeOrder('o-2', 'bob@example.com', 7_500, { refundCents: 2_000 });

    await waitFor(() => accounting.handled.some((e) => e.orderId === 'o-2'));
    await waitFor(() => rabbitmq.emit.mock.calls.length >= 1);

    // RabbitMQ got the refund event, with target = 'refunds' queue.
    expect(rabbitmq.emit).toHaveBeenCalledWith(
      'refunds',
      expect.objectContaining({ refundId: 'refund-o-2', orderId: 'o-2', amountCents: 2_000 }),
    );

    // Kafka got the order-placed event (still fires alongside) — but
    // NOT the refund event.
    const kafkaTargets = kafka.emit.mock.calls.map((c) => c[0]);
    expect(kafkaTargets).toEqual(['orders.placed']);
    expect(kafkaTargets).not.toContain('refunds');

    // Redis got the cache invalidation — but NOT the refund.
    const redisTargets = redis.emit.mock.calls.map((c) => c[0]);
    expect(redisTargets).toEqual(['cache.invalidated']);
    expect(redisTargets).not.toContain('refunds');
  });

  it('routes CacheInvalidationEvent to Redis ONLY', async () => {
    await orders.placeOrder('o-3', 'carol@example.com', 1_000);

    await waitFor(() => cache.handled.some((e) => e.key.includes('carol@example.com')));
    await waitFor(() => redis.emit.mock.calls.length >= 1);

    expect(redis.emit).toHaveBeenCalledWith(
      'cache.invalidated',
      expect.objectContaining({
        key: 'customer:carol@example.com:pricing',
        reason: expect.stringContaining('o-3'),
      }),
    );

    // Cache event did NOT land on Kafka or RabbitMQ.
    expect(kafka.emit.mock.calls.map((c) => c[0])).not.toContain('cache.invalidated');
    expect(rabbitmq.emit.mock.calls.map((c) => c[0])).not.toContain('cache.invalidated');
  });

  it('atomicity: rollback drops ALL three publications — NO broker receives anything', async () => {
    await expect(
      orders.placeOrder('o-4', 'dave@example.com', 9_999, { refundCents: 1_000, fail: true }),
    ).rejects.toThrow('simulated failure');

    // No DB rows.
    expect(await dataSource.getRepository(OrderEntity).find()).toHaveLength(0);
    expect(await dataSource.getRepository(EventPublicationEntity).find()).toHaveLength(0);

    // No broker emits — atomicity gate covers all three.
    await new Promise((r) => setTimeout(r, 300));
    expect(kafka.emit).not.toHaveBeenCalled();
    expect(rabbitmq.emit).not.toHaveBeenCalled();
    expect(redis.emit).not.toHaveBeenCalled();
  });

  it('one transaction → three brokers; all three publications COMPLETED on success', async () => {
    await orders.placeOrder('o-5', 'eve@example.com', 3_500, { refundCents: 500 });

    await waitFor(
      () =>
        shipping.handled.some((e) => e.orderId === 'o-5') &&
        accounting.handled.some((e) => e.orderId === 'o-5') &&
        cache.handled.some((e) => e.key.includes('eve@example.com')),
    );

    await waitFor(
      () =>
        kafka.emit.mock.calls.length >= 1 &&
        rabbitmq.emit.mock.calls.length >= 1 &&
        redis.emit.mock.calls.length >= 1,
    );

    expect(kafka.emit).toHaveBeenCalledTimes(1);
    expect(rabbitmq.emit).toHaveBeenCalledTimes(1);
    expect(redis.emit).toHaveBeenCalledTimes(1);

    const completedRows = await dataSource.getRepository(EventPublicationEntity).find();
    expect(completedRows).toHaveLength(3);
    expect(completedRows.every((r) => r.status === PublicationStatus.COMPLETED)).toBe(true);

    const eventTypes = completedRows.map((r) => r.eventType).sort();
    expect(eventTypes).toEqual([
      'CacheInvalidationEvent',
      'OrderPlacedEvent',
      'RefundRequestedEvent',
    ]);
  });

  it('isolated broker failure: Kafka throws → only OrderPlacedEvent FAILED; RabbitMQ + Redis emits still happen', async () => {
    kafka.emit.mockImplementation(() => {
      throw new Error('simulated Kafka rejection');
    });

    await orders.placeOrder('o-6', 'frank@example.com', 2_000, { refundCents: 200 });

    // Local handlers all run regardless of which broker is unhappy.
    await waitFor(
      () =>
        shipping.handled.some((e) => e.orderId === 'o-6') &&
        accounting.handled.some((e) => e.orderId === 'o-6') &&
        cache.handled.some((e) => e.key.includes('frank@example.com')),
    );

    // RabbitMQ + Redis succeeded — those publications complete.
    await waitFor(
      () => rabbitmq.emit.mock.calls.length >= 1 && redis.emit.mock.calls.length >= 1,
    );

    // The OrderPlacedEvent publication ends up FAILED. The other two
    // publications complete independently — single-unit atomicity is
    // PER PUBLICATION ROW (DD-019), not across the three.
    await waitFor(async () => {
      const rows = await dataSource.getRepository(EventPublicationEntity).find();
      const orderRow = rows.find((r) => r.eventType === 'OrderPlacedEvent');
      const refundRow = rows.find((r) => r.eventType === 'RefundRequestedEvent');
      const cacheRow = rows.find((r) => r.eventType === 'CacheInvalidationEvent');
      return (
        orderRow?.status === PublicationStatus.FAILED &&
        refundRow?.status === PublicationStatus.COMPLETED &&
        cacheRow?.status === PublicationStatus.COMPLETED
      );
    });

    const orderRow = await dataSource
      .getRepository(EventPublicationEntity)
      .findOne({ where: { eventType: 'OrderPlacedEvent' } });
    expect(orderRow?.failureReason).toMatch(/simulated Kafka rejection/);
  });
});
