import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import {
  AggregateRoot,
  CommandBus,
  CommandHandler,
  CqrsModule,
  EventBus,
  EventPublisher,
  type ICommandHandler,
} from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type TransactionAdapter,
  type TransactionHandle,
  TransactionalModule,
  type TransactionOptions,
  Transactional,
} from '@nestjs-transactional/core';

import { TransactionalEventsListener } from '../decorators/transactional-events-listener.decorator';
import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';
import { CqrsTransactionalBootstrap } from '../handlers/bootstrap';
import {
  CQRS_HANDLER_WRAPPER_OPTIONS,
  CqrsHandlerWrapper,
} from '../handlers/handler-wrapper';
import { TransactionalListenerScanner } from '../handlers/listener-scanner';
import { TransactionPhase } from '../types/transactional-listener.types';

import { TransactionalEventPublisher } from './transactional-event-publisher';
import { TransactionalEventPublisherAdapter } from './transactional-event-publisher-adapter';

// Inline fake adapter — `@nestjs-transactional/core/testing` subpath is
// not resolvable under the monorepo's `moduleResolution: "node"` setting.
interface FakeHandle extends TransactionHandle {
  readonly id: string;
  readonly adapterName: string;
}

interface FakeCommit {
  readonly id: string;
  readonly options: TransactionOptions;
}

interface FakeRollback extends FakeCommit {
  readonly error: unknown;
}

class FakeAdapter implements TransactionAdapter<FakeHandle> {
  readonly name = 'in-memory';
  committedTransactions: FakeCommit[] = [];
  rolledBackTransactions: FakeRollback[] = [];

  async runInTransaction<T>(
    options: TransactionOptions,
    fn: (handle: FakeHandle) => Promise<T>,
  ): Promise<T> {
    const handle: FakeHandle = { id: randomUUID(), adapterName: this.name };
    try {
      const result = await fn(handle);
      this.committedTransactions.push({ id: handle.id, options });
      return result;
    } catch (error) {
      this.rolledBackTransactions.push({ id: handle.id, options, error });
      throw error;
    }
  }

  async runInSavepoint<T>(parent: FakeHandle, fn: (handle: FakeHandle) => Promise<T>): Promise<T> {
    return fn(parent);
  }
}

// --- Domain under test ---

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class Order extends AggregateRoot {
  place(orderId: string): void {
    this.apply(new OrderPlacedEvent(orderId));
  }
}

// Gate used by tests that need to observe aggregate state *while* the
// enclosing transaction is still open. Set before command dispatch; the
// handler awaits it after emitting events and before returning.
let midTransactionGate: Promise<void> | null = null;

class PlaceOrderCommand {
  constructor(readonly orderId: string, readonly shouldFail = false) {}
}

class PlaceOrderClassCommand {
  constructor(readonly orderId: string) {}
}

@CommandHandler(PlaceOrderCommand)
@Injectable()
class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, void> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new Order());
    order.place(command.orderId);
    order.commit();

    if (midTransactionGate !== null) {
      await midTransactionGate;
    }

    if (command.shouldFail) {
      throw new Error('boom');
    }
  }
}

@CommandHandler(PlaceOrderClassCommand)
@Injectable()
class PlaceOrderClassHandler implements ICommandHandler<PlaceOrderClassCommand, void> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(command: PlaceOrderClassCommand): Promise<void> {
    const OrderClass = this.publisher.mergeClassContext(Order);
    const order = new OrderClass();
    order.place(command.orderId);
    order.commit();
  }
}

@Injectable()
class OrderListener {
  afterCommit: OrderPlacedEvent[] = [];
  afterRollback: { event: OrderPlacedEvent; error: unknown }[] = [];

  @TransactionalEventsListener(OrderPlacedEvent)
  onCommitted(event: OrderPlacedEvent): void {
    this.afterCommit.push(event);
  }

  @TransactionalEventsListener(OrderPlacedEvent, { phase: TransactionPhase.AFTER_ROLLBACK })
  onRolledBack(event: OrderPlacedEvent, error: unknown): void {
    this.afterRollback.push({ event, error });
  }
}

// --- Harness ---

const drainEventLoop = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const buildModule = async (adapter: FakeAdapter): Promise<TestingModule> => {
  const module = await Test.createTestingModule({
    imports: [
      TransactionalModule.forRoot({
        isGlobal: true,
        adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
        registerInterceptor: false,
      }),
      CqrsModule.forRoot(),
      DiscoveryModule,
    ],
    providers: [
      {
        provide: CQRS_HANDLER_WRAPPER_OPTIONS,
        useValue: {
          wrapCommandHandlers: true,
          wrapQueryHandlers: true,
          wrapEventHandlers: true,
        },
      },
      TransactionalEventDispatcher,
      TransactionalListenerScanner,
      CqrsHandlerWrapper,
      CqrsTransactionalBootstrap,
      TransactionalEventPublisher,
      {
        provide: EventPublisher,
        useFactory: (publisher: TransactionalEventPublisher, eventBus: EventBus) =>
          new TransactionalEventPublisherAdapter(publisher, eventBus),
        inject: [TransactionalEventPublisher, EventBus],
      },
      PlaceOrderHandler,
      PlaceOrderClassHandler,
      OrderListener,
    ],
  }).compile();

  await module.init();
  return module;
};

describe('TransactionalEventPublisher (integration with AggregateRoot)', () => {
  let adapter: FakeAdapter;
  let module: TestingModule;
  let commandBus: CommandBus;
  let listener: OrderListener;

  beforeEach(async () => {
    adapter = new FakeAdapter();
    module = await buildModule(adapter);
    commandBus = module.get(CommandBus);
    listener = module.get(OrderListener);
    midTransactionGate = null;
  });

  afterEach(async () => {
    midTransactionGate = null;
    if (module !== undefined) {
      await module.close();
    }
  });

  it('holds the AFTER_COMMIT listener back while the transaction is still open, then fires it on commit', async () => {
    let release: () => void = () => undefined;
    midTransactionGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(listener.afterCommit).toHaveLength(0);

    const exec = commandBus.execute(new PlaceOrderCommand('o-1'));
    // Let the handler enter the await.
    await new Promise<void>((r) => setImmediate(r));

    // Aggregate has emitted and "committed" its event to the dispatcher,
    // but the enclosing transaction hasn't committed yet.
    expect(listener.afterCommit).toHaveLength(0);
    expect(adapter.committedTransactions).toHaveLength(0);

    release();
    await exec;
    await drainEventLoop();

    expect(listener.afterCommit).toHaveLength(1);
    expect(listener.afterCommit[0]?.orderId).toBe('o-1');
    expect(adapter.committedTransactions).toHaveLength(1);
  });

  it('does not fire an AFTER_COMMIT listener when the transaction rolls back', async () => {
    await expect(
      commandBus.execute(new PlaceOrderCommand('o-fail', true)),
    ).rejects.toThrow('boom');
    await drainEventLoop();

    expect(listener.afterCommit).toHaveLength(0);
    expect(adapter.rolledBackTransactions).toHaveLength(1);
  });

  it('fires an AFTER_ROLLBACK listener with the causing error when the transaction rolls back', async () => {
    await expect(
      commandBus.execute(new PlaceOrderCommand('o-fail-2', true)),
    ).rejects.toThrow('boom');
    await drainEventLoop();

    expect(listener.afterRollback).toHaveLength(1);
    expect(listener.afterRollback[0]?.event.orderId).toBe('o-fail-2');
    expect(listener.afterRollback[0]?.error).toBeInstanceOf(Error);
    expect((listener.afterRollback[0]?.error as Error).message).toBe('boom');
  });

  it('mergeClassContext produces an aggregate class whose events also flow through the dispatcher', async () => {
    await commandBus.execute(new PlaceOrderClassCommand('o-class-7'));
    await drainEventLoop();

    expect(listener.afterCommit.map((e) => e.orderId)).toContain('o-class-7');
    expect(adapter.committedTransactions).toHaveLength(1);
  });
});
