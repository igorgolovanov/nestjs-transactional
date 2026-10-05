import { Global, Injectable, Module, type Provider } from '@nestjs/common';
import {
  AggregateRoot,
  CommandBus,
  CommandHandler,
  CqrsModule,
  EventBus,
  EventPublisher,
  EventsHandler,
  type ICommandHandler,
  type IEvent,
  type IEventHandler,
  type IEventPublisher,
} from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Transactional, TransactionalModule } from '@nestjs-transactional/core';
import {
  TypeOrmTransactionalModule,
  getCurrentEntityManager,
  isInTransaction,
} from '@nestjs-transactional/typeorm';
import { DataSource, Entity, PrimaryColumn } from 'typeorm';

import { TransactionalEventsHandler } from '../decorators/transactional-events-handler.decorator.js';
import { TransactionPhase } from '../types/transactional-listener.types.js';

import { CqrsTransactionalModule } from './cqrs-transactional.module.js';

// Aggregate events reach @nestjs/cqrs's EventBus, so @EventsHandler,
// sagas and publishers that wrap EventBus.publisher (WorkflowsCqrsModule)
// see them, while phase handlers keep their phases (ADR-024, DD-029).

@Entity({ name: 'orders' })
class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;
}

class OrderPlaced implements IEvent {
  constructor(readonly orderId: string) {}
}

class StockChecked implements IEvent {
  constructor(readonly sku: string) {}
}

class Order extends AggregateRoot {
  constructor(readonly id: string) {
    super();
  }
  place(): void {
    this.apply(new OrderPlaced(this.id));
  }
}

/** Shared, ordered record of what ran, and whether inside a transaction. */
@Injectable()
class Journal {
  readonly entries: string[] = [];
  add(entry: string): void {
    this.entries.push(entry);
  }
}

class PlaceOrder {
  constructor(
    readonly orderId: string,
    readonly fail = false,
    readonly context?: unknown,
  ) {}
}

@CommandHandler(PlaceOrder)
@Injectable()
class PlaceOrderHandler implements ICommandHandler<PlaceOrder> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(command: PlaceOrder): Promise<void> {
    const order = this.publisher.mergeObjectContext(new Order(command.orderId));
    order.place();
    await getCurrentEntityManager().save(OrderRow, { id: command.orderId });
    // Not awaited, as most code calls it: on @nestjs/cqrs 11 commit()
    // returns nothing at all.
    if (command.context === undefined) {
      order.commit();
    } else {
      (order.commit as (context: unknown) => unknown)(command.context);
    }
    if (command.fail) {
      throw new Error('simulated failure');
    }
  }
}

@Injectable()
class DirectPublisher {
  constructor(private readonly eventBus: EventBus) {}

  @Transactional()
  async publishInTransaction(sku: string): Promise<void> {
    await this.eventBus.publish(new StockChecked(sku));
  }
}

@EventsHandler(OrderPlaced)
@Injectable()
class ReserveStock implements IEventHandler<OrderPlaced> {
  constructor(private readonly journal: Journal) {}
  handle(event: OrderPlaced): void {
    this.journal.add(`events-handler ${event.orderId} inTx=${isInTransaction()}`);
  }
}

@TransactionalEventsHandler(OrderPlaced)
@Injectable()
class OrderProjection {
  constructor(private readonly journal: Journal) {}
  handle(event: OrderPlaced): void {
    this.journal.add(`after-commit ${event.orderId}`);
  }
}

@TransactionalEventsHandler({ events: [OrderPlaced], phase: TransactionPhase.AFTER_ROLLBACK })
@Injectable()
class CompensateOrder {
  constructor(private readonly journal: Journal) {}
  handle(event: OrderPlaced, error?: unknown): void {
    this.journal.add(`after-rollback ${event.orderId} ${String((error as Error).message)}`);
  }
}

class PlaceOrderByClass {
  constructor(readonly orderId: string) {}
}

@CommandHandler(PlaceOrderByClass)
@Injectable()
class PlaceOrderByClassHandler implements ICommandHandler<PlaceOrderByClass> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(command: PlaceOrderByClass): Promise<void> {
    const Merged = this.publisher.mergeClassContext(Order);
    const order = new Merged(command.orderId);
    order.place();
    order.commit();
  }
}

@TransactionalEventsHandler({ events: [StockChecked], phase: TransactionPhase.BEFORE_COMMIT })
@Injectable()
class StockAudit {
  constructor(private readonly journal: Journal) {}
  handle(event: StockChecked): void {
    this.journal.add(`before-commit ${event.sku} inTx=${isInTransaction()}`);
  }
}

/**
 * Stands in for @nestjs/workflows' WorkflowEventPublisher: it wraps
 * EventBus.publisher in its constructor, reads the dispatcher context's
 * `transaction`, and forwards to the wrapped publisher only after an
 * asynchronous write.
 */
@Injectable()
class OuterPublisher implements IEventPublisher {
  readonly contexts: unknown[] = [];
  fail = false;
  private readonly inner: IEventPublisher;

  constructor(eventBus: EventBus) {
    this.inner = eventBus.publisher;
    eventBus.publisher = this;
  }

  publish<T extends IEvent>(event: T, context?: unknown, asyncContext?: unknown): Promise<void> {
    this.contexts.push(context);
    return Promise.resolve().then(async () => {
      if (this.fail) {
        throw new Error('workflow write failed');
      }
      await (this.inner.publish as (...args: unknown[]) => unknown)(event, context, asyncContext);
    });
  }

  publishAll<T extends IEvent>(
    events: T[],
    context?: unknown,
    asyncContext?: unknown,
  ): Promise<void> {
    const all = [...events];
    return Promise.all(all.map((event) => this.publish(event, context, asyncContext))).then(
      () => undefined,
    );
  }
}

function fakeTypeOrm(ds: DataSource): unknown {
  const providers: Provider[] = [{ provide: getDataSourceToken(), useValue: ds }];
  @Global()
  @Module({ providers, exports: [getDataSourceToken()] })
  class FakeTypeOrmModule {}
  return FakeTypeOrmModule;
}

async function build(
  ds: DataSource,
  extra: { providers?: Provider[]; imports?: unknown[] } = {},
): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeTypeOrm(ds) as any,
      TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
      TypeOrmTransactionalModule.forRoot(),
      CqrsTransactionalModule.forRoot(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...((extra.imports ?? []) as any[]),
    ],
    providers: [
      Journal,
      PlaceOrderHandler,
      DirectPublisher,
      ReserveStock,
      OrderProjection,
      StockAudit,
      CompensateOrder,
      PlaceOrderByClassHandler,
      ...(extra.providers ?? []),
    ],
  }).compile();
  await module.init();
  return module;
}

/** Whether this @nestjs/cqrs forwards commit(context) to the publisher (12.1 and later). */
function commitForwardsContext(): boolean {
  let received: unknown;
  const probe = new (class extends AggregateRoot {})();
  (probe as unknown as { publishAll: (events: unknown[], context?: unknown) => void }).publishAll =
    (_events, context) => {
      received = context;
    };
  probe.apply({}, { skipHandler: true } as never);
  (probe.commit as (context: unknown) => unknown)('probe');
  return received === 'probe';
}

const itOnCommitContext = commitForwardsContext() ? it : it.skip;

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('CqrsTransactionalModule and the @nestjs/cqrs EventBus', () => {
  let ds: DataSource;
  let module: TestingModule | undefined;

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();
    ds = new DataSource({ type: 'sqljs', synchronize: true, entities: [OrderRow] });
    await ds.initialize();
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
    await ds.destroy();
  });

  it('delivers an aggregate event to @EventsHandler at once, inside the transaction, and to a phase handler after the commit', async () => {
    module = await build(ds);

    await module.get(CommandBus).execute(new PlaceOrder('o-1'));
    await settle();

    expect(module.get(Journal).entries).toEqual([
      'events-handler o-1 inTx=true',
      'after-commit o-1',
    ]);
  });

  it('does not run the phase handler when the transaction rolls back', async () => {
    module = await build(ds);

    await expect(module.get(CommandBus).execute(new PlaceOrder('o-2', true))).rejects.toThrow(
      'simulated failure',
    );
    await settle();

    expect(module.get(Journal).entries).toEqual([
      'events-handler o-2 inTx=true',
      'after-rollback o-2 simulated failure',
    ]);
  });

  it('routes the events of a mergeClassContext aggregate the same way', async () => {
    module = await build(ds);

    await module.get(CommandBus).execute(new PlaceOrderByClass('o-7'));
    await settle();

    expect(module.get(Journal).entries).toEqual([
      'events-handler o-7 inTx=true',
      'after-commit o-7',
    ]);
  });

  it('schedules phase handlers for a direct eventBus.publish() inside a transaction', async () => {
    module = await build(ds);

    await module.get(DirectPublisher).publishInTransaction('sku-1');

    expect(module.get(Journal).entries).toEqual(['before-commit sku-1 inTx=true']);
  });

  it('hands an outer publisher the transaction, for aggregate and direct publishes alike', async () => {
    module = await build(ds, { providers: [OuterPublisher] });
    const outer = module.get(OuterPublisher);

    await module.get(CommandBus).execute(new PlaceOrder('o-3'));
    await module.get(DirectPublisher).publishInTransaction('sku-3');

    expect(outer.contexts).toHaveLength(2);
    for (const context of outer.contexts) {
      const transaction = (context as { transaction?: { queryRunner?: unknown } }).transaction;
      expect(transaction?.queryRunner).toBeDefined();
    }
  });

  it('keeps the commit waiting for an outer publisher that forwards asynchronously', async () => {
    module = await build(ds, { providers: [OuterPublisher] });

    await module.get(CommandBus).execute(new PlaceOrder('o-4'));
    await settle();

    expect(module.get(Journal).entries).toEqual([
      'events-handler o-4 inTx=true',
      'after-commit o-4',
    ]);
  });

  it('rolls the transaction back when an outer publisher rejects', async () => {
    module = await build(ds, { providers: [OuterPublisher] });
    module.get(OuterPublisher).fail = true;

    await expect(module.get(CommandBus).execute(new PlaceOrder('o-5'))).rejects.toThrow(
      'workflow write failed',
    );

    expect(await ds.manager.count(OrderRow)).toBe(0);
    expect(module.get(Journal).entries).toEqual([]);
  });

  itOnCommitContext(
    'leaves a dispatcher context the caller passed to commit() untouched',
    async () => {
      module = await build(ds, { providers: [OuterPublisher] });
      const mine = { transaction: 'mine' };

      await module.get(CommandBus).execute(new PlaceOrder('o-6', false, mine));

      expect(module.get(OuterPublisher).contexts).toEqual([mine]);
    },
  );

  it('fails at bootstrap when EventBus.publisher is replaced without wrapping ours', async () => {
    @Injectable()
    class Replacer {
      constructor(eventBus: EventBus) {
        eventBus.publisher = { publish: () => undefined };
      }
    }

    await expect(build(ds, { providers: [Replacer] })).rejects.toThrow(
      /EventBus\.publisher was replaced/,
    );
  });

  it('fails at bootstrap when the application imports CqrsModule a second time', async () => {
    await expect(build(ds, { imports: [CqrsModule] })).rejects.toThrow(/2 @nestjs\/cqrs EventBus/);
  });

  it('exposes the stock CqrsModule buses to the application', async () => {
    module = await build(ds);

    expect(module.get(CommandBus)).toBeInstanceOf(CommandBus);
    expect(module.get(EventBus)).toBeInstanceOf(EventBus);
  });
});
