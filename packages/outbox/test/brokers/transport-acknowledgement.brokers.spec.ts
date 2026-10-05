import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ClientKafka, ClientRMQ } from '@nestjs/microservices';
import { type OutboxEnvelope, OutboxRelay } from '@nestjs/outbox';
import type { TestingModule } from '@nestjs/testing';
import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import * as amqplib from 'amqplib';
import { type Admin, Kafka } from 'kafkajs';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

import { toKafkaPacket } from '../../src/index.js';
import {
  buildApp,
  ORDER_PLACED_TOPIC,
  OrderService,
  pendingMessages,
  type PostgresContext,
  startPostgres,
  stopPostgres,
} from '../support/app.js';

/**
 * What a broker's acknowledgement means for an outbox message, measured
 * against real brokers rather than inferred from the abstraction.
 *
 * This suite exists because the opposite was once recorded as fact.
 * ADR-016 concluded that `ClientProxy.emit()` cannot report broker
 * failures; re-measured, Kafka and RabbitMQ both reject when the broker
 * is gone and deliver when it is up (ADR-021). From 3.0.0 the emit runs
 * inside `@nestjs/outbox`'s relay, so the claim to pin is the one an
 * application relies on: a delivered message leaves the outbox, and a
 * message whose broker is down stays in it, with a reason an operator
 * can read, to be retried.
 *
 * Deliberately not asserted: that a broker cannot accept a message and
 * then lose it before durable storage. `acks: -1` and replication address
 * that, and no client library can close it.
 */

/**
 * A fresh single-node Kafka can report `controllerId: -1` for a moment,
 * and kafkajs' `createTopics` gives up on the first attempt for every
 * error but `NOT_CONTROLLER`. Each attempt refreshes the metadata, so
 * retrying from the outside picks up the controller once it appears.
 */
async function createTopic(admin: Admin, topic: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let pg: PostgresContext;

beforeAll(async () => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  pg = await startPostgres();
}, 180_000);

afterAll(async () => {
  await stopPostgres(pg);
});

beforeEach(async () => {
  await pg.dataSource.query(
    'TRUNCATE nest_outbox.messages, nest_outbox.dead_letters, bridge_orders',
  );
});

describe('RabbitMQ (testcontainers)', () => {
  let container: StartedTestContainer;
  let url: string;
  let client: ClientRMQ;
  let app: TestingModule;

  beforeAll(async () => {
    container = await new GenericContainer('rabbitmq:3.13-alpine').withExposedPorts(5672).start();
    url = `amqp://${container.getHost()}:${container.getMappedPort(5672)}`;
    client = new ClientRMQ({
      urls: [url],
      queue: ORDER_PLACED_TOPIC,
      queueOptions: { durable: false },
    });
    await client.connect();
    app = await buildApp(pg.dataSource, client);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await client?.close().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

  it('delivers the envelope and removes the message from the outbox', async () => {
    await app.get(OrderService).place('o-1');
    await app.get(OutboxRelay).runOnce();

    expect(await pendingMessages(pg.dataSource)).toEqual([]);

    // Read it straight off the queue: leaving the outbox is only
    // meaningful if the message is actually there.
    const conn = await amqplib.connect(url);
    const channel = await conn.createChannel();
    await channel.assertQueue(ORDER_PLACED_TOPIC, { durable: false });
    const message = await channel.get(ORDER_PLACED_TOPIC, { noAck: true });
    await channel.close();
    await conn.close();

    expect(message).not.toBe(false);
    const packet = JSON.parse((message as amqplib.GetMessage).content.toString()) as {
      pattern: string;
      data: OutboxEnvelope<{ orderId: string }>;
    };
    expect(packet.pattern).toBe(ORDER_PLACED_TOPIC);
    expect(packet.data.payload).toEqual({ orderId: 'o-1' });
    expect(packet.data.key).toBe('o-1');
  });

  it('keeps the message, with a readable reason, when the broker is gone', async () => {
    await container.stop();

    await app.get(OrderService).place('o-2');
    await app.get(OutboxRelay).runOnce();

    const [pending] = await pendingMessages(pg.dataSource);
    expect(pending).toMatchObject({ topic: ORDER_PLACED_TOPIC, key: 'o-2', attempts: 1 });
    // RabbitMQ rejects with values that are not `Error`s; a reason
    // rendered as `[object Object]` would leave an operator nothing.
    expect(pending!.last_error).toBeTruthy();
    expect(pending!.last_error).not.toContain('[object Object]');
  }, 120_000);
});

describe('Kafka (testcontainers)', () => {
  let container: StartedKafkaContainer;
  let broker: string;
  let client: ClientKafka;
  let app: TestingModule;

  beforeAll(async () => {
    container = await new KafkaContainer('confluentinc/cp-kafka:7.6.0')
      .withExposedPorts(9093)
      .start();
    broker = `${container.getHost()}:${container.getMappedPort(9093)}`;

    const admin = new Kafka({ clientId: 'probe-admin', brokers: [broker], logLevel: 0 }).admin();
    await admin.connect();
    await createTopic(admin, ORDER_PLACED_TOPIC);
    await admin.disconnect();

    client = new ClientKafka({ client: { clientId: 'probe', brokers: [broker], logLevel: 0 } });
    await client.connect();
    app = await buildApp(pg.dataSource, client, { toPacket: toKafkaPacket });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await client?.close().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

  it('delivers with the routing key as the Kafka key, headers, and the envelope as value', async () => {
    const received: { key?: string; headers: Record<string, string>; value: string }[] = [];
    const consumer = new Kafka({
      clientId: 'probe-consumer',
      brokers: [broker],
      logLevel: 0,
    }).consumer({ groupId: 'probe-group' });
    await consumer.connect();
    await consumer.subscribe({ topic: ORDER_PLACED_TOPIC, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        received.push({
          key: message.key?.toString(),
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)]),
          ),
          value: message.value?.toString() ?? '',
        });
      },
    });

    try {
      await app.get(OrderService).place('o-k');
      await app.get(OutboxRelay).runOnce();
      expect(await pendingMessages(pg.dataSource)).toEqual([]);

      const deadline = Date.now() + 20_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      await consumer.disconnect();
    }

    expect(received).toHaveLength(1);
    const [message] = received;
    expect(message!.key).toBe('o-k');
    expect(message!.headers).toMatchObject({
      source: 'bridge-spec',
      'x-event-type': 'OrderPlaced',
    });
    const envelope = JSON.parse(message!.value) as OutboxEnvelope<{ orderId: string }>;
    expect(message!.headers['x-outbox-id']).toBe(envelope.id);
    expect(envelope.payload).toEqual({ orderId: 'o-k' });
  }, 60_000);

  it('keeps the message when the broker is gone, to be retried', async () => {
    await container.stop();

    await app.get(OrderService).place('o-down');
    await app.get(OutboxRelay).runOnce();

    const [pending] = await pendingMessages(pg.dataSource);
    expect(pending).toMatchObject({ topic: ORDER_PLACED_TOPIC, key: 'o-down', attempts: 1 });
    expect(pending!.last_error).toBeTruthy();
  }, 120_000);
});
