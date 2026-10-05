import 'reflect-metadata';

import { Global, Injectable, Module, type ModuleMetadata } from '@nestjs/common';
import {
  AggregateRoot,
  CommandHandler,
  CqrsModule,
  EventPublisher,
  type ICommandHandler,
} from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  Workflow,
  WorkflowClient,
  type WorkflowContext,
  type WorkflowRunner,
  WorkflowSignal,
  WorkflowsModule,
  WorkflowStorage,
} from '@nestjs/workflows';
import { StartOn, WorkflowsCqrsModule } from '@nestjs/workflows/cqrs';
import { fromTypeOrm, PostgresWorkflowStore } from '@nestjs/workflows/postgres';
import { Transactional, TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalCqrsModule } from '@nestjs-transactional/cqrs';
import { getCurrentEntityManager, TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, Entity, PrimaryColumn } from 'typeorm';

import { TransactionalWorkflowsModule } from '../../src/index.js';

@Entity({ name: 'wf_orders' })
export class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;
}

export class OrderPlaced {
  constructor(readonly orderId: string) {}
}

export const delivered = new WorkflowSignal<{ readonly carrier: string }>('order.delivered');

export const fulfilmentId = (orderId: string): string => `fulfil-${orderId}`;

/** Started by `OrderPlaced`, or by hand; finishes at once. */
@StartOn(OrderPlaced, { id: (event) => fulfilmentId(event.orderId), input: (event) => event })
@Workflow('fulfil-order')
export class FulfilOrder implements WorkflowRunner<OrderPlaced, string> {
  async run(ctx: WorkflowContext, input: OrderPlaced): Promise<string> {
    return ctx.step('fulfil', async () => `fulfilled ${input.orderId}`);
  }
}

/** Parks until `delivered` arrives for its order. */
@Workflow('await-delivery')
export class AwaitDelivery implements WorkflowRunner<{ readonly orderId: string }, string> {
  async run(ctx: WorkflowContext, input: { readonly orderId: string }): Promise<string> {
    const event = await ctx.waitForSignal('delivery', delivered, {
      key: input.orderId,
      timeout: '1h',
    });
    return `delivered by ${event?.carrier ?? 'nobody'}`;
  }
}

class Order extends AggregateRoot {
  constructor(readonly id: string) {
    super();
  }
  place(): void {
    this.apply(new OrderPlaced(this.id));
  }
}

export class PlaceOrder {
  constructor(
    readonly orderId: string,
    readonly fail = false,
  ) {}
}

@CommandHandler(PlaceOrder)
@Injectable()
export class PlaceOrderHandler implements ICommandHandler<PlaceOrder> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(command: PlaceOrder): Promise<void> {
    await getCurrentEntityManager().save(OrderRow, { id: command.orderId });
    const order = this.publisher.mergeObjectContext(new Order(command.orderId));
    order.place();
    // Not awaited, as most code calls it.
    order.commit();
    if (command.fail) {
      throw new Error('forced rollback');
    }
  }
}

/** Calls `WorkflowClient` directly, with no `transaction` option anywhere. */
@Injectable()
export class Orders {
  constructor(
    private readonly client: WorkflowClient,
    private readonly publisher: EventPublisher,
  ) {}

  /**
   * The aggregate path from a plain service: with stock `CqrsModule`
   * nothing wraps command handlers in a transaction, since
   * `TransactionalMethodsBootstrap` leaves CQRS handlers to
   * `TransactionalCqrsModule` (ADR-005).
   */
  @Transactional()
  async placeViaAggregate(id: string, fail = false): Promise<void> {
    await getCurrentEntityManager().save(OrderRow, { id });
    const order = this.publisher.mergeObjectContext(new Order(id));
    order.place();
    order.commit();
    if (fail) {
      throw new Error('forced rollback');
    }
  }

  @Transactional()
  async placeAndStart(id: string, fail = false): Promise<void> {
    await getCurrentEntityManager().save(OrderRow, { id });
    await this.client.start(FulfilOrder, new OrderPlaced(id), { id: fulfilmentId(id) });
    if (fail) {
      throw new Error('forced rollback');
    }
  }

  @Transactional({ isolation: 'SERIALIZABLE' })
  async placeAndStartSerializable(id: string): Promise<void> {
    await getCurrentEntityManager().save(OrderRow, { id });
    await this.client.start(FulfilOrder, new OrderPlaced(id), { id: fulfilmentId(id) });
  }

  @Transactional()
  async deliver(id: string, fail = false): Promise<void> {
    await getCurrentEntityManager().save(OrderRow, { id: `${id}-delivered` });
    await this.client.signal(delivered, { carrier: 'ups' }, { key: id });
    if (fail) {
      throw new Error('forced rollback');
    }
  }

  @Transactional({ isolation: 'SERIALIZABLE' })
  async deliverSerializable(id: string): Promise<void> {
    await getCurrentEntityManager().save(OrderRow, { id: `${id}-delivered` });
    await this.client.signal(delivered, { carrier: 'ups' }, { key: id });
  }

  @Transactional()
  async startAndWaitInside(id: string): Promise<unknown> {
    return this.client.startAndWait(FulfilOrder, new OrderPlaced(id), { id: fulfilmentId(id) });
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

/**
 * The application the suites run: `@nestjs/workflows` with its PostgreSQL
 * store on the TypeORM DataSource, a worker, `WorkflowsCqrsModule`, and
 * the bridge on top. `cqrs` picks how `@nestjs/cqrs` is wired: through
 * `TransactionalCqrsModule`, or stock `CqrsModule.forRoot()`.
 */
export async function buildApp(
  dataSource: DataSource,
  cqrs: 'transactional' | 'stock' = 'transactional',
): Promise<TestingModule> {
  TransactionalModule.resetForTesting();
  TransactionalTypeOrmModule.resetForTesting();

  @Global()
  @Module({
    providers: [
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: DataSource, useValue: dataSource },
    ],
    exports: [getDataSourceToken(), DataSource],
  })
  class InfraModule {}

  const imports: ModuleMetadata['imports'] = [
    InfraModule,
    TransactionalModule.forRoot({
      isGlobal: true,
      registerInterceptor: false,
      registerMethodsBootstrap: true,
    }),
    TransactionalTypeOrmModule.forRoot({ isDefault: true }),
    cqrs === 'transactional' ? TransactionalCqrsModule.forRoot() : CqrsModule.forRoot(),
    WorkflowsModule.forRoot({ worker: { pollInterval: '50ms' } }),
    WorkflowsCqrsModule,
    TransactionalWorkflowsModule.forRoot(),
  ];

  const app = await Test.createTestingModule({
    imports,
    providers: [
      FulfilOrder,
      AwaitDelivery,
      PlaceOrderHandler,
      Orders,
      {
        provide: PostgresWorkflowStore,
        inject: [DataSource, WorkflowStorage],
        useFactory: (ds: DataSource, storage: WorkflowStorage) =>
          new PostgresWorkflowStore({ executor: fromTypeOrm(ds) }, storage),
      },
    ],
  }).compile();
  await app.init();
  return app;
}
