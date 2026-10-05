import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
  ClientProxyTransport,
  type OutboxEnvelope,
  OutboxModule,
  OutboxRelay,
  OutboxStorage,
} from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { PropagationMode, Transactional, TransactionalModule } from '@nestjs-transactional/core';
import { getCurrentEntityManager, TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type Admin, Kafka } from 'kafkajs';
import { of } from 'rxjs';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';

import {
  Externalized,
  externalizedRoute,
  OutboxEventPublisher,
  toKafkaPacket,
  TransactionalOutboxModule,
} from '../../src/index.js';

/**
 * The bridge against real infrastructure (DD-028): messages added through
 * `OutboxEventPublisher` share the fate of the business rows under every
 * propagation that matters, reach a `ClientProxy` as an envelope, and,
 * through `toKafkaPacket`, arrive in Kafka with a real key and headers.
 */

@Entity({ name: 'bridge_orders' })
class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  note!: string;
}

@Externalized<OrderPlaced>({
  target: 'bridge.orders.placed',
  client: 'ANALYTICS',
  routingKey: (e) => e.orderId,
  headers: { source: 'bridge-spec' },
})
class OrderPlaced {
  constructor(readonly orderId: string) {}
}

/** Not externalized: goes to topic `StockReserved`, routed `local`. */
class StockReserved {
  constructor(readonly orderId: string) {}
}

@Injectable()
class OrderService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  async write(id: string): Promise<void> {
    await getCurrentEntityManager().save(OrderRow, { id, note: 'x' });
    await this.publisher.publish(new OrderPlaced(id));
  }

  @Transactional()
  async place(id: string): Promise<void> {
    await this.write(id);
  }

  @Transactional()
  async placeThenFail(id: string): Promise<void> {
    await this.write(id);
    throw new Error('forced rollback');
  }

  @Transactional()
  async placeWithLocalFollowUp(id: string): Promise<void> {
    await this.write(id);
    await this.publisher.publish(new StockReserved(id));
  }

  @Transactional({ propagation: PropagationMode.REQUIRES_NEW })
  async placeIndependently(id: string): Promise<void> {
    await this.write(id);
  }

  @Transactional({ propagation: PropagationMode.NESTED })
  async placeNestedThenFail(id: string): Promise<void> {
    await this.write(id);
    throw new Error('savepoint rollback');
  }
}

@Injectable()
class Caller {
  constructor(private readonly orders: OrderService) {}

  @Transactional()
  async outerFailsAroundRequiresNew(outer: string, inner: string): Promise<void> {
    await this.orders.placeIndependently(inner);
    await this.orders.write(outer);
    throw new Error('outer rollback');
  }

  @Transactional()
  async outerCommitsAroundFailedNested(outer: string, nested: string): Promise<void> {
    await this.orders.write(outer);
    await this.orders.placeNestedThenFail(nested).catch(() => undefined);
  }

  @Transactional({ isolation: 'SERIALIZABLE' })
  async placeSerializable(id: string): Promise<void> {
    await this.orders.write(id);
  }
}

async function startPostgres(): Promise<{
  container: StartedPostgreSqlContainer;
  dataSource: DataSource;
}> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const dataSource = new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
    entities: [OrderRow],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  return { container, dataSource };
}

async function buildApp(
  dataSource: DataSource,
  client: unknown,
  toPacket?: typeof toKafkaPacket,
): Promise<TestingModule> {
  TransactionalModule.resetForTesting();
  TypeOrmTransactionalModule.resetForTesting();

  @Global()
  @Module({
    providers: [
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: DataSource, useValue: dataSource },
      { provide: 'ANALYTICS', useValue: client },
    ],
    exports: [getDataSourceToken(), DataSource, 'ANALYTICS'],
  })
  class InfraModule {}

  const app = await Test.createTestingModule({
    imports: [
      InfraModule,
      TransactionalModule.forRoot({
        isGlobal: true,
        registerInterceptor: false,
        registerMethodsBootstrap: true,
      }),
      TypeOrmTransactionalModule.forRoot({ isDefault: true }),
      OutboxModule.forRoot({
        transports: {
          ANALYTICS: ClientProxyTransport('ANALYTICS', toPacket ? { toPacket } : undefined),
        },
        route: externalizedRoute(),
        relay: { enabled: false },
      }),
      TransactionalOutboxModule.forRoot(),
    ],
    providers: [
      OrderService,
      Caller,
      {
        provide: PostgresOutboxStore,
        inject: [DataSource, OutboxStorage],
        useFactory: (ds: DataSource, storage: OutboxStorage) =>
          new PostgresOutboxStore({ executor: fromTypeOrm(ds) }, storage),
      },
    ],
  }).compile();
  await app.init();
  return app;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('outbox bridge on PostgreSQL (testcontainers)', () => {
  let pg: Awaited<ReturnType<typeof startPostgres>>;
  let app: TestingModule;
  const emitted: { pattern: unknown; data: unknown }[] = [];

  const messages = async (): Promise<{ topic: string; key: string | null }[]> =>
    pg.dataSource.query('SELECT topic, key FROM nest_outbox.messages ORDER BY topic, key');
  const orders = async (): Promise<string[]> =>
    (await pg.dataSource.getRepository(OrderRow).find({ order: { id: 'ASC' } })).map((o) => o.id);

  beforeAll(async () => {
    pg = await startPostgres();
    app = await buildApp(pg.dataSource, {
      emit: (pattern: unknown, data: unknown) => {
        emitted.push({ pattern, data });
        return of(undefined);
      },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.dataSource.destroy();
    await pg?.container.stop();
  });

  beforeEach(async () => {
    await pg.dataSource.query('TRUNCATE nest_outbox.messages, bridge_orders');
    emitted.length = 0;
  });

  it('commits the message with the business row', async () => {
    await app.get(OrderService).place('o-1');

    expect(await orders()).toEqual(['o-1']);
    expect(await messages()).toEqual([{ topic: 'bridge.orders.placed', key: 'o-1' }]);
  });

  it('rolls the message back with the business row', async () => {
    await expect(app.get(OrderService).placeThenFail('o-2')).rejects.toThrow('forced rollback');

    expect(await orders()).toEqual([]);
    expect(await messages()).toEqual([]);
  });

  it('keeps a REQUIRES_NEW message when the outer transaction rolls back', async () => {
    await expect(app.get(Caller).outerFailsAroundRequiresNew('outer', 'inner')).rejects.toThrow(
      'outer rollback',
    );

    expect(await orders()).toEqual(['inner']);
    expect(await messages()).toEqual([{ topic: 'bridge.orders.placed', key: 'inner' }]);
  });

  it('drops a NESTED message with its savepoint while the outer one commits', async () => {
    await app.get(Caller).outerCommitsAroundFailedNested('outer', 'nested');

    expect(await orders()).toEqual(['outer']);
    expect(await messages()).toEqual([{ topic: 'bridge.orders.placed', key: 'outer' }]);
  });

  it('works under SERIALIZABLE isolation', async () => {
    await app.get(Caller).placeSerializable('o-ser');

    expect(await messages()).toEqual([{ topic: 'bridge.orders.placed', key: 'o-ser' }]);
  });

  it('writes a non-externalized event under its class name', async () => {
    await app.get(OrderService).placeWithLocalFollowUp('o-3');

    expect(await messages()).toEqual([
      { topic: 'StockReserved', key: null },
      { topic: 'bridge.orders.placed', key: 'o-3' },
    ]);
  });

  it('refuses to publish outside a transaction', async () => {
    await expect(app.get(OutboxEventPublisher).publish(new OrderPlaced('o-4'))).rejects.toThrow(
      /inside a transaction/,
    );
    expect(await messages()).toEqual([]);
  });

  it('delivers the envelope through the routed ClientProxy transport', async () => {
    await app.get(OrderService).place('o-5');
    await app.get(OutboxRelay).runOnce();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.pattern).toBe('bridge.orders.placed');
    const envelope = emitted[0]!.data as OutboxEnvelope<{ orderId: string }>;
    expect(envelope.payload).toEqual({ orderId: 'o-5' });
    expect(envelope.key).toBe('o-5');
    expect(envelope.headers).toEqual({ source: 'bridge-spec', 'x-event-type': 'OrderPlaced' });
    expect(await messages()).toEqual([]);
  });
});

/**
 * Same as in outbox-microservices' reliability suite: a fresh single-node
 * Kafka can report `controllerId: -1` for a moment, and kafkajs'
 * `createTopics` gives up on the first attempt.
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

describe('toKafkaPacket against a real broker (testcontainers)', () => {
  let pg: Awaited<ReturnType<typeof startPostgres>>;
  let kafka: StartedKafkaContainer;
  let broker: string;
  let client: ClientKafka;
  let app: TestingModule;

  beforeAll(async () => {
    [pg, kafka] = await Promise.all([
      startPostgres(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.0').withExposedPorts(9093).start(),
    ]);
    broker = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;

    const admin = new Kafka({ clientId: 'bridge-admin', brokers: [broker], logLevel: 0 }).admin();
    await admin.connect();
    await createTopic(admin, 'bridge.orders.placed');
    await admin.disconnect();

    client = new ClientKafka({ client: { clientId: 'bridge', brokers: [broker], logLevel: 0 } });
    await client.connect();
    app = await buildApp(pg.dataSource, client, toKafkaPacket);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await client?.close().catch(() => undefined);
    await pg?.dataSource.destroy();
    await pg?.container.stop();
    await kafka?.stop().catch(() => undefined);
  });

  it('arrives with the routing key as the Kafka key, headers, and the envelope as value', async () => {
    const received: { key?: string; headers: Record<string, string>; value: string }[] = [];
    const consumer = new Kafka({
      clientId: 'bridge-consumer',
      brokers: [broker],
      logLevel: 0,
    }).consumer({ groupId: 'bridge-group' });
    await consumer.connect();
    await consumer.subscribe({ topic: 'bridge.orders.placed', fromBeginning: true });
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
});
