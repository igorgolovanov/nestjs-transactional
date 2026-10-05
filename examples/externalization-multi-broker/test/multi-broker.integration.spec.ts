import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { type ClientProxy } from '@nestjs/microservices';
import { type OutboxEnvelope, OutboxRelay } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { of } from 'rxjs';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { KAFKA_CLIENT, RABBITMQ_CLIENT, REDIS_CLIENT } from '../src/clients.js';
import { OrderEntity } from '../src/order.entity.js';
import { OrderService } from '../src/order.service.js';

interface ProxyMock {
  proxy: ClientProxy;
  emit: jest.Mock<(pattern: string, data: unknown) => unknown>;
}

function makeProxy(): ProxyMock {
  const emit = jest.fn((_pattern: string, _data: unknown) => of(undefined));
  const proxy = { emit } as unknown as ClientProxy;
  return { proxy, emit };
}

const patterns = (mock: ProxyMock): string[] => mock.emit.mock.calls.map(([p]) => p);

/**
 * One transaction, three events, three brokers. Postgres is real; each
 * broker is a recording `ClientProxy`, because the question here is
 * routing and isolation, not what a broker acknowledges (that is the
 * outbox package's broker suite, ADR-021). The relay is off and driven
 * with `runOnce()`, so delivery happens exactly when a test asks for it.
 */
describe('externalization-multi-broker (Postgres real, three ClientProxy recorded)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let orders: OrderService;
  let relay: OutboxRelay;
  let kafka: ProxyMock;
  let rabbitmq: ProxyMock;
  let redis: ProxyMock;

  const pending = async (): Promise<{ topic: string; attempts: number }[]> =>
    dataSource.query('SELECT topic, attempts FROM nest_outbox.messages ORDER BY seq');

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TransactionalTypeOrmModule.resetForTesting();

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
          { relay: false },
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
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await module.init();

    dataSource = module.get<DataSource>(getDataSourceToken());
    orders = module.get(OrderService);
    relay = module.get(OutboxRelay);
  }, 120_000);

  afterAll(async () => {
    await module?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE nest_outbox.messages, nest_outbox.dead_letters');
    await dataSource.getRepository(OrderEntity).clear();
    for (const mock of [kafka, rabbitmq, redis]) {
      mock.emit.mockClear();
      mock.emit.mockImplementation(() => of(undefined));
    }
  });

  it('routes OrderPlacedEvent to Kafka only, keyed by the order id', async () => {
    await orders.placeOrder('o-1', 'alice@example.com', 5_000);
    await relay.runOnce();

    expect(patterns(kafka)).toEqual(['orders.placed']);
    const record = kafka.emit.mock.calls[0]![1] as {
      key: string;
      headers: Record<string, string>;
      value: OutboxEnvelope<{ orderId: string }>;
    };
    expect(record.key).toBe('o-1');
    expect(record.headers).toMatchObject({ 'x-customer': 'alice@example.com' });
    expect(record.value.payload).toMatchObject({ orderId: 'o-1' });
    expect(patterns(rabbitmq)).toEqual([]);
  });

  it('routes RefundRequestedEvent to RabbitMQ only, as an envelope', async () => {
    await orders.placeOrder('o-2', 'bob@example.com', 7_500, { refundCents: 2_000 });
    await relay.runOnce();

    expect(patterns(rabbitmq)).toEqual(['refunds']);
    const envelope = rabbitmq.emit.mock.calls[0]![1] as OutboxEnvelope<{ refundId: string }>;
    expect(envelope.payload).toMatchObject({ refundId: 'refund-o-2', amountCents: 2_000 });
    expect(envelope.headers).toMatchObject({ 'x-correlation-id': 'refund-o-2' });
    expect(patterns(kafka)).toEqual(['orders.placed']);
  });

  it('routes CacheInvalidationEvent to Redis only', async () => {
    await orders.placeOrder('o-3', 'carol@example.com', 1_000);
    await relay.runOnce();

    expect(patterns(redis)).toEqual(['cache.invalidated']);
    const envelope = redis.emit.mock.calls[0]![1] as OutboxEnvelope<{ key: string }>;
    expect(envelope.payload).toMatchObject({ key: 'customer:carol@example.com:pricing' });
  });

  it('atomicity: a rollback leaves no message, so no broker receives anything', async () => {
    await expect(
      orders.placeOrder('o-4', 'dave@example.com', 2_000, { refundCents: 500, fail: true }),
    ).rejects.toThrow('simulated failure');

    expect(await dataSource.getRepository(OrderEntity).find()).toHaveLength(0);
    expect(await pending()).toEqual([]);

    await relay.runOnce();
    for (const mock of [kafka, rabbitmq, redis]) {
      expect(mock.emit).not.toHaveBeenCalled();
    }
  });

  it('one transaction, three brokers: every message is delivered and leaves the outbox', async () => {
    await orders.placeOrder('o-5', 'erin@example.com', 3_000, { refundCents: 1_000 });
    expect(await pending()).toHaveLength(3);

    await relay.runOnce();

    expect(patterns(kafka)).toEqual(['orders.placed']);
    expect(patterns(rabbitmq)).toEqual(['refunds']);
    expect(patterns(redis)).toEqual(['cache.invalidated']);
    expect(await pending()).toEqual([]);
  });

  it('isolated broker failure: Kafka rejects, only its message stays; the others are delivered', async () => {
    kafka.emit.mockImplementation(() => {
      throw new Error('simulated Kafka outage');
    });

    await orders.placeOrder('o-6', 'frank@example.com', 4_000, { refundCents: 750 });
    await relay.runOnce();

    expect(patterns(rabbitmq)).toEqual(['refunds']);
    expect(patterns(redis)).toEqual(['cache.invalidated']);
    expect(await pending()).toEqual([{ topic: 'orders.placed', attempts: 1 }]);
  });
});
