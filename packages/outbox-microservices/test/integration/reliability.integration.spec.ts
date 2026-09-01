import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ClientKafka, ClientRMQ } from '@nestjs/microservices';
import { ExternalizationError } from '@nestjs-transactional/outbox';
import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import * as amqplib from 'amqplib';
import { Kafka } from 'kafkajs';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

import { MicroservicesEventExternalizer } from '../../src/externalizer/microservices-event-externalizer';
import { OUTBOX_MICROSERVICES_OPTIONS } from '../../src/types/options';

/**
 * What `ClientProxy.emit()` actually guarantees, measured against real
 * brokers rather than inferred from the abstraction.
 *
 * These tests exist because the opposite was once recorded as fact.
 * ADR-016 concluded that `emit()` cannot report broker failures, removed
 * the real-broker suite, and left a documented "silent success" gap that
 * a whole planned phase of native broker adapters was meant to close. On
 * current `@nestjs/microservices`, `kafkajs` and `amqplib`, that
 * conclusion does not reproduce: an unreachable broker rejects, and a
 * reachable one delivers.
 *
 * The suite pins both halves. If a future version regresses to silent
 * success, the "rejects" cases fail here rather than being discovered by
 * a user whose publication was marked COMPLETED with nothing delivered.
 *
 * Deliberately not asserted: that a broker cannot accept a message and
 * then lose it before durable storage. `acks: -1` and replication are
 * what address that, it cannot be reproduced deterministically from a
 * client, and no client library can close it.
 */

const TOPIC = 'reliability.probe';
const QUEUE = 'reliability-probe';

function externalizerFor(token: string, client: unknown): MicroservicesEventExternalizer {
  const moduleRef = {
    get: (requested: unknown) => {
      if (requested === token) {
        return client;
      }
      throw new Error(`no provider for ${String(requested)}`);
    },
  };
  return new MicroservicesEventExternalizer(
    moduleRef as never,
    { defaultClient: token, validateOnBootstrap: false } as never,
  );
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('externalization reliability (RabbitMQ via testcontainers)', () => {
  let container: StartedTestContainer;
  let url: string;
  let client: ClientRMQ;
  let externalizer: MicroservicesEventExternalizer;

  beforeAll(async () => {
    container = await new GenericContainer('rabbitmq:3.13-alpine').withExposedPorts(5672).start();
    url = `amqp://${container.getHost()}:${container.getMappedPort(5672)}`;

    client = new ClientRMQ({ urls: [url], queue: QUEUE, queueOptions: { durable: false } });
    await client.connect();
    externalizer = externalizerFor('RMQ', client);
  }, 180_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

  it('delivers to the broker and resolves', async () => {
    await expect(
      externalizer.externalize(
        { orderId: 'o-1' },
        { eventType: 'OrderPlacedEvent', target: QUEUE },
      ),
    ).resolves.toBeUndefined();

    // Read it straight off the queue: resolving is only meaningful if
    // the message is actually there.
    const conn = await amqplib.connect(url);
    const channel = await conn.createChannel();
    await channel.assertQueue(QUEUE, { durable: false });
    const message = await channel.get(QUEUE, { noAck: true });
    await channel.close();
    await conn.close();

    expect(message).not.toBe(false);
  });

  it('rejects when the broker is gone, so the publication can be FAILED', async () => {
    await container.stop();

    await expect(
      externalizer.externalize(
        { orderId: 'o-2' },
        { eventType: 'OrderPlacedEvent', target: QUEUE },
      ),
    ).rejects.toBeInstanceOf(ExternalizationError);
  });

  it('reports a readable reason, not [object Object]', async () => {
    // The broker is already stopped by the previous case. RabbitMQ
    // rejects with values that are not `Error`s, which `String()` would
    // render as `[object Object]` and leave an operator with nothing.
    let thrown: unknown;
    try {
      await externalizer.externalize(
        { orderId: 'o-3' },
        { eventType: 'OrderPlacedEvent', target: QUEUE },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ExternalizationError);
    const { message } = thrown as ExternalizationError;
    expect(message).not.toContain('[object Object]');
    expect(message).toContain('Failed to publish OrderPlacedEvent');
  });
});

describe('externalization reliability (Kafka via testcontainers)', () => {
  let container: StartedKafkaContainer;
  let broker: string;
  let client: ClientKafka;
  let externalizer: MicroservicesEventExternalizer;

  beforeAll(async () => {
    container = await new KafkaContainer('confluentinc/cp-kafka:7.6.0').withExposedPorts(9093).start();
    broker = `${container.getHost()}:${container.getMappedPort(9093)}`;

    // Pre-create the topic so the test measures delivery rather than
    // auto-creation timing.
    const admin = new Kafka({ clientId: 'probe-admin', brokers: [broker], logLevel: 0 }).admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }], waitForLeaders: true });
    await admin.disconnect();

    client = new ClientKafka({ client: { clientId: 'probe', brokers: [broker], logLevel: 0 } });
    await client.connect();
    externalizer = externalizerFor('KAFKA', client);
  }, 180_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

  it('delivers to a consumer that subscribed before the publish', async () => {
    const received: string[] = [];
    const consumer = new Kafka({ clientId: 'probe-consumer', brokers: [broker], logLevel: 0 }).consumer(
      { groupId: 'probe-group' },
    );
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        received.push(message.value?.toString() ?? '');
      },
    });
    // Let the consumer group stabilise before publishing.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    await expect(
      externalizer.externalize(
        { orderId: 'o-1' },
        { eventType: 'OrderPlacedEvent', target: TOPIC },
      ),
    ).resolves.toBeUndefined();

    const deadline = Date.now() + 15_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await consumer.disconnect();

    // ADR-016 also recorded that an independent consumer did not
    // reliably observe the message even with the broker up.
    expect(received).toHaveLength(1);
  });

  it('rejects when the broker is gone, so the publication can be FAILED', async () => {
    await container.stop();

    await expect(
      externalizer.externalize(
        { orderId: 'o-2' },
        { eventType: 'OrderPlacedEvent', target: TOPIC },
      ),
    ).rejects.toBeInstanceOf(ExternalizationError);
  }, 120_000);
});
