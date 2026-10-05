import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { type ClientProxy } from '@nestjs/microservices';
import { type OutboxEnvelope, OutboxRelay } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { of } from 'rxjs';
import type { DataSource } from 'typeorm';

import { AppModule, KAFKA_CLIENT } from '../src/app.module.js';
import { OrderEntity } from '../src/order.entity.js';
import { OrderService } from '../src/order.service.js';

/** What `toKafkaPacket` makes `ClientKafka.emit()` send. */
interface KafkaRecord {
  readonly key?: string;
  readonly value: OutboxEnvelope<{ orderId: string; customerEmail: string }>;
  readonly headers: Record<string, string>;
}

describe('externalization-kafka (Postgres real, ClientProxy recorded)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let orders: OrderService;
  let relay: OutboxRelay;
  let kafkaEmit: jest.Mock<(pattern: string, record: KafkaRecord) => unknown>;

  const pending = async (): Promise<{ key: string; attempts: number; last_error: string }[]> =>
    dataSource.query('SELECT key, attempts, last_error FROM nest_outbox.messages ORDER BY seq');

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // Records what reaches the Kafka client. Deliberately not a broker
    // test: what a real Kafka acknowledgement means for an outbox message
    // is measured in the outbox package's broker suite (ADR-021).
    kafkaEmit = jest.fn((_pattern: string, _record: KafkaRecord) => of(undefined));
    const kafkaProxy = { emit: kafkaEmit } as unknown as ClientProxy;

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
          { brokers: ['unused-recorded'], clientId: 'test' },
          { relay: false },
        ),
      ],
    })
      .overrideProvider(KAFKA_CLIENT)
      .useValue(kafkaProxy)
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
    kafkaEmit.mockClear();
    kafkaEmit.mockImplementation(() => of(undefined));
  });

  it('commits the order and its message together; the relay sends a keyed Kafka record', async () => {
    await orders.placeOrder('o-1', 'alice@example.com', 5_000);

    expect((await dataSource.getRepository(OrderEntity).find()).map((o) => o.id)).toEqual(['o-1']);
    expect(await pending()).toHaveLength(1);

    await relay.runOnce();

    expect(kafkaEmit).toHaveBeenCalledTimes(1);
    const [topic, record] = kafkaEmit.mock.calls[0]!;
    expect(topic).toBe('orders.placed');
    // The routing key is the Kafka key: one order, one partition.
    expect(record.key).toBe('o-1');
    expect(record.headers).toMatchObject({
      'x-customer': 'alice@example.com',
      'x-event-type': 'OrderPlacedEvent',
      'x-outbox-id': record.value.id,
    });
    expect(record.value.payload).toMatchObject({ orderId: 'o-1' });
    expect(await pending()).toEqual([]);
  });

  it('rolls back the order and its message together; nothing reaches Kafka', async () => {
    await expect(orders.placeOrderAndFail('o-2', 'bob@example.com', 7_500)).rejects.toThrow(
      'simulated failure',
    );

    expect(await dataSource.getRepository(OrderEntity).find()).toHaveLength(0);
    expect(await pending()).toEqual([]);

    await relay.runOnce();
    expect(kafkaEmit).not.toHaveBeenCalled();
  });

  it('keeps a message the broker rejects, with the reason, for a retry', async () => {
    // What an unreachable broker produces: `producer.send()` rejects, and
    // with the default `acks: -1` waits for every in-sync replica first.
    kafkaEmit.mockImplementation(() => {
      throw new Error('simulated broker rejection');
    });

    await orders.placeOrder('o-3', 'carol@example.com', 3_000);
    await relay.runOnce();

    const [message] = await pending();
    expect(message).toMatchObject({ key: 'o-3', attempts: 1 });
    expect(message!.last_error).toMatch(/simulated broker rejection/);
  });
});
