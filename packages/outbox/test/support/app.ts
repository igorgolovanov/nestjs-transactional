import 'reflect-metadata';

import { Global, Injectable, Module } from '@nestjs/common';
import {
  ClientProxyTransport,
  type ClientProxyTransportOptions,
  OutboxModule,
  OutboxStorage,
} from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { PropagationMode, Transactional, TransactionalModule } from '@nestjs-transactional/core';
import { getCurrentEntityManager, TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';

import {
  Externalized,
  externalizedRoute,
  OutboxEventPublisher,
  TransactionalOutboxModule,
} from '../../src/index.js';

/** The transport name every externalized event in the suites goes to. */
export const BROKER = 'BROKER';
export const ORDER_PLACED_TOPIC = 'bridge.orders.placed';

@Entity({ name: 'bridge_orders' })
export class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  note!: string;
}

@Externalized<OrderPlaced>({
  target: ORDER_PLACED_TOPIC,
  client: BROKER,
  routingKey: (e) => e.orderId,
  headers: { source: 'bridge-spec' },
})
export class OrderPlaced {
  constructor(readonly orderId: string) {}
}

/** Not externalized: goes to topic `StockReserved`, routed `local`. */
export class StockReserved {
  constructor(readonly orderId: string) {}
}

@Injectable()
export class OrderService {
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
export class Caller {
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

export interface PostgresContext {
  readonly container: StartedPostgreSqlContainer;
  readonly dataSource: DataSource;
}

export async function startPostgres(): Promise<PostgresContext> {
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

export async function stopPostgres(ctx: PostgresContext | undefined): Promise<void> {
  if (ctx?.dataSource.isInitialized) {
    await ctx.dataSource.destroy();
  }
  await ctx?.container.stop();
}

/** Rows still waiting in the outbox, oldest first. */
export async function pendingMessages(
  dataSource: DataSource,
): Promise<{ topic: string; key: string | null; attempts: number; last_error: string | null }[]> {
  return dataSource.query(
    'SELECT topic, key, attempts, last_error FROM nest_outbox.messages ORDER BY seq',
  );
}

/**
 * The application the suites run: `@nestjs/outbox` with its PostgreSQL
 * store and one `ClientProxyTransport` named {@link BROKER}, our bridge on
 * top, and the relay switched off so each test drives it with
 * `runOnce()`.
 */
export async function buildApp(
  dataSource: DataSource,
  client: unknown,
  transportOptions?: ClientProxyTransportOptions,
): Promise<TestingModule> {
  TransactionalModule.resetForTesting();
  TransactionalTypeOrmModule.resetForTesting();

  @Global()
  @Module({
    providers: [
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: DataSource, useValue: dataSource },
      { provide: BROKER, useValue: client },
    ],
    exports: [getDataSourceToken(), DataSource, BROKER],
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
      TransactionalTypeOrmModule.forRoot({ isDefault: true }),
      OutboxModule.forRoot({
        transports: { [BROKER]: ClientProxyTransport(BROKER, transportOptions) },
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
