import { Injectable } from '@nestjs/common';
import {
  AggregateRoot,
  CommandBus,
  CommandHandler,
  EventPublisher,
  type ICommandHandler,
} from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionalModule, Transactional } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule, getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';

import { TransactionalEventsHandler } from '../decorators/transactional-events-handler.decorator';
import type { ITransactionalEventHandler } from '../interfaces/transactional-event-handler.interface';

import { CqrsTransactionalModule } from './cqrs-transactional.module';

// --- Schema ---

@Entity({ name: 'orders' })
class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  note!: string;
}

async function createSqlJsDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'sqljs',
    synchronize: true,
    entities: [OrderRow],
  });
  await ds.initialize();
  return ds;
}

// --- Domain ---

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class Order extends AggregateRoot {
  constructor(readonly id: string) {
    super();
  }
  place(): void {
    this.apply(new OrderPlacedEvent(this.id));
  }
}

// --- Infra services (plain Injectable, rely on AsyncLocalStorage context) ---

@Injectable()
class OrderRepository {
  async save(order: Order, note: string): Promise<void> {
    const em = getCurrentEntityManager('default');
    await em.save(OrderRow, { id: order.id, note });
  }

  async findById(id: string, ds: DataSource): Promise<OrderRow | null> {
    return ds.manager.findOne(OrderRow, { where: { id } });
  }
}

/**
 * Shared service called from inside a command handler. It has no own
 * `@Transactional()` — it just reads/writes through
 * `getCurrentEntityManager('default')`, which picks up the enclosing
 * handler's transactional context (same AsyncLocalStorage scope).
 * Demonstrates "nested call joins the handler's transaction" without
 * going through `commandBus` from within a handler.
 */
@Injectable()
class AuditTrail {
  async recordOrder(id: string): Promise<void> {
    const em = getCurrentEntityManager('default');
    await em.save(OrderRow, { id: `${id}-audit`, note: 'audit' });
  }
}

// --- Commands + handlers ---

class PlaceOrderCommand {
  constructor(
    readonly orderId: string,
    readonly shouldFail = false,
  ) {}
}

@CommandHandler(PlaceOrderCommand)
@Injectable()
class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, void> {
  constructor(
    private readonly publisher: EventPublisher,
    private readonly repo: OrderRepository,
    private readonly audit: AuditTrail,
  ) {}

  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new Order(command.orderId));
    order.place();
    await this.repo.save(order, 'placed');
    await this.audit.recordOrder(command.orderId);

    order.commit();

    if (command.shouldFail) {
      throw new Error('simulated failure');
    }
  }
}

// --- Listener ---

@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
class OrderProjection implements ITransactionalEventHandler<OrderPlacedEvent> {
  placed: string[] = [];

  handle(event: OrderPlacedEvent): void {
    this.placed.push(event.orderId);
  }
}

// --- Harness ---

const buildModule = async (ds: DataSource): Promise<TestingModule> => {
  const module = await Test.createTestingModule({
    imports: [
      TransactionalModule.forRoot({
        isGlobal: true,
        registerInterceptor: false,
      }),
      TypeOrmTransactionalModule.forFeature({ dataSource: ds }),
      CqrsTransactionalModule.forRoot(),
    ],
    providers: [OrderRepository, AuditTrail, PlaceOrderHandler, OrderProjection],
  }).compile();

  await module.init();
  return module;
};

describe('CqrsTransactionalModule (E2E: TypeORM + CQRS + Transactional)', () => {
  let ds: DataSource;
  let module: TestingModule;

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    ds = await createSqlJsDataSource();
  });

  afterEach(async () => {
    if (module !== undefined) {
      await module.close();
    }
    await ds.destroy();
  });

  it('persists the aggregate AND invokes the AFTER_COMMIT listener exactly once', async () => {
    module = await buildModule(ds);
    const commandBus = module.get(CommandBus);
    const projection = module.get(OrderProjection);
    const repo = module.get(OrderRepository);

    await commandBus.execute(new PlaceOrderCommand('order-1'));

    const row = await repo.findById('order-1', ds);
    expect(row).not.toBeNull();
    expect(row?.note).toBe('placed');
    expect(projection.placed).toEqual(['order-1']);
  });

  it('rolls back the aggregate AND suppresses the AFTER_COMMIT listener when the handler throws', async () => {
    module = await buildModule(ds);
    const commandBus = module.get(CommandBus);
    const projection = module.get(OrderProjection);
    const repo = module.get(OrderRepository);

    await expect(commandBus.execute(new PlaceOrderCommand('order-2', true))).rejects.toThrow(
      'simulated failure',
    );

    const row = await repo.findById('order-2', ds);
    expect(row).toBeNull();
    expect(projection.placed).toEqual([]);

    // Audit row also rolled back.
    const audit = await repo.findById('order-2-audit', ds);
    expect(audit).toBeNull();
  });

  it('nested call through a shared service joins the handler transaction — single commit', async () => {
    module = await buildModule(ds);
    const commandBus = module.get(CommandBus);
    const repo = module.get(OrderRepository);

    await commandBus.execute(new PlaceOrderCommand('order-3'));

    // Both the main row and the audit row persisted via the same
    // EntityManager owned by the handler's transaction. If they had run
    // in separate tx contexts, the rollback test above wouldn't work —
    // that's the tightest proof of shared-tx behaviour.
    const main = await repo.findById('order-3', ds);
    const audit = await repo.findById('order-3-audit', ds);
    expect(main).not.toBeNull();
    expect(audit).not.toBeNull();
    expect(audit?.note).toBe('audit');
  });
});
