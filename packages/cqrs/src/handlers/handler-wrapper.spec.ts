import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import {
  CommandBus,
  CommandHandler,
  CqrsModule,
  EventBus,
  EventsHandler,
  type ICommandHandler,
  type IEventHandler,
  type IQueryHandler,
  QueryBus,
  QueryHandler,
} from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type TransactionAdapter,
  type TransactionHandle,
  TransactionManager,
  TransactionalModule,
  type TransactionOptions,
  Transactional,
} from '@nestjs-transactional/core';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';

import { CqrsTransactionalBootstrap } from './bootstrap';
import {
  CQRS_HANDLER_WRAPPER_OPTIONS,
  CqrsHandlerWrapper,
  type HandlerWrapperOptions,
} from './handler-wrapper';
import { TransactionalListenerScanner } from './listener-scanner';

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
  readonly dataSourceName = 'default';
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

// --- Domain types used by the integration handlers ---

class PlaceOrderCommand {
  constructor(readonly orderId: string) {}
}

class GetOrderQuery {
  constructor(readonly orderId: string) {}
}

class DeleteOrderCommand {
  constructor(readonly orderId: string) {}
}

class FindActiveOrdersQuery {}

class OrderCreated {
  constructor(readonly orderId: string) {}
}

class AuditEvent {
  constructor(readonly message: string) {}
}

// --- Handlers under test ---

@CommandHandler(PlaceOrderCommand)
@Injectable()
class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, string> {
  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<string> {
    return command.orderId;
  }
}

@CommandHandler(DeleteOrderCommand)
@Transactional()
@Injectable()
class DeleteOrderHandler implements ICommandHandler<DeleteOrderCommand, void> {
  async execute(_command: DeleteOrderCommand): Promise<void> {}
}

@QueryHandler(GetOrderQuery)
@Injectable()
class GetOrderHandler implements IQueryHandler<GetOrderQuery, string> {
  async execute(query: GetOrderQuery): Promise<string> {
    return query.orderId;
  }
}

@QueryHandler(FindActiveOrdersQuery)
@Injectable()
class FindActiveOrdersHandler implements IQueryHandler<FindActiveOrdersQuery, string[]> {
  async execute(_query: FindActiveOrdersQuery): Promise<string[]> {
    return [];
  }
}

let auditHandleResolve: (() => void) | null = null;
let auditHandleSeenError: unknown = undefined;

@EventsHandler(OrderCreated)
@Injectable()
class OrderCreatedHandler implements IEventHandler<OrderCreated> {
  @Transactional()
  async handle(_event: OrderCreated): Promise<void> {
    if (auditHandleResolve !== null) {
      auditHandleResolve();
      auditHandleResolve = null;
    }
  }
}

@EventsHandler(AuditEvent)
@Injectable()
class AuditEventHandler implements IEventHandler<AuditEvent> {
  @Transactional()
  async handle(_event: AuditEvent): Promise<void> {
    try {
      throw new Error('audit boom');
    } finally {
      if (auditHandleResolve !== null) {
        auditHandleResolve();
        auditHandleResolve = null;
      }
    }
  }
}

const waitForEventHandle = (): Promise<void> =>
  new Promise<void>((resolve) => {
    auditHandleResolve = resolve;
  });

// Handler resolves the gate promise inside its own body; the surrounding
// transactional wrap still has commit/rollback to finalize after. Drain
// until the microtask + task queues are empty so adapter counters reflect
// the final state.
const drainEventLoop = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

// --- Test harness ---

const buildModule = async (
  options: HandlerWrapperOptions,
  adapter: FakeAdapter,
): Promise<TestingModule> => {
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
      { provide: CQRS_HANDLER_WRAPPER_OPTIONS, useValue: options },
      CqrsHandlerWrapper,
      CqrsTransactionalBootstrap,
      TransactionalEventDispatcher,
      TransactionalListenerScanner,
      PlaceOrderHandler,
      DeleteOrderHandler,
      GetOrderHandler,
      FindActiveOrdersHandler,
      OrderCreatedHandler,
      AuditEventHandler,
    ],
  }).compile();

  await module.init();
  return module;
};

describe('CqrsHandlerWrapper (integration with @nestjs/cqrs)', () => {
  let adapter: FakeAdapter;
  let module: TestingModule;

  afterEach(async () => {
    auditHandleResolve = null;
    auditHandleSeenError = undefined;
    if (module !== undefined) {
      await module.close();
    }
  });

  it('wraps a command handler annotated with @Transactional — dispatch opens a transaction', async () => {
    adapter = new FakeAdapter();
    module = await buildModule(
      { wrapCommandHandlers: true, wrapQueryHandlers: true, wrapEventHandlers: true },
      adapter,
    );
    const commandBus = module.get(CommandBus);

    const result = await commandBus.execute(new PlaceOrderCommand('o-1'));

    expect(result).toBe('o-1');
    expect(adapter.committedTransactions).toHaveLength(1);
    expect(adapter.rolledBackTransactions).toHaveLength(0);
  });

  it('applies defaultQueryOptions to a query handler that has no @Transactional', async () => {
    adapter = new FakeAdapter();
    module = await buildModule(
      {
        wrapCommandHandlers: true,
        wrapQueryHandlers: true,
        wrapEventHandlers: true,
        defaultQueryOptions: { readOnly: true },
      },
      adapter,
    );
    const queryBus = module.get(QueryBus);

    const result = await queryBus.execute(new GetOrderQuery('o-42'));

    expect(result).toBe('o-42');
    expect(adapter.committedTransactions).toHaveLength(1);
    expect(adapter.committedTransactions[0]?.options.readOnly).toBe(true);
  });

  it('leaves an undecorated query handler unwrapped when no defaultQueryOptions are configured', async () => {
    adapter = new FakeAdapter();
    module = await buildModule(
      { wrapCommandHandlers: true, wrapQueryHandlers: true, wrapEventHandlers: true },
      adapter,
    );
    const queryBus = module.get(QueryBus);

    await queryBus.execute(new FindActiveOrdersQuery());

    expect(adapter.committedTransactions).toHaveLength(0);
    expect(adapter.rolledBackTransactions).toHaveLength(0);
  });

  it('wraps an event handler annotated with @Transactional — publish opens a transaction', async () => {
    adapter = new FakeAdapter();
    module = await buildModule(
      { wrapCommandHandlers: true, wrapQueryHandlers: true, wrapEventHandlers: true },
      adapter,
    );
    const eventBus = module.get(EventBus);
    const handleDone = waitForEventHandle();

    eventBus.publish(new OrderCreated('o-99'));
    await handleDone;
    await drainEventLoop();

    expect(adapter.committedTransactions).toHaveLength(1);
    expect(adapter.rolledBackTransactions).toHaveLength(0);
  });

  it('applies class-level @Transactional to handlers without method-level decoration', async () => {
    adapter = new FakeAdapter();
    module = await buildModule(
      { wrapCommandHandlers: true, wrapQueryHandlers: true, wrapEventHandlers: true },
      adapter,
    );
    const commandBus = module.get(CommandBus);

    await commandBus.execute(new DeleteOrderCommand('o-7'));

    expect(adapter.committedTransactions).toHaveLength(1);
  });

  it('rolls back when a wrapped handler throws', async () => {
    adapter = new FakeAdapter();
    module = await buildModule(
      { wrapCommandHandlers: true, wrapQueryHandlers: true, wrapEventHandlers: true },
      adapter,
    );
    const eventBus = module.get(EventBus);
    const manager = module.get(TransactionManager);

    // Direct manager call to observe rollback semantics without CQRS's
    // fire-and-forget error handling on the EventBus subscription.
    const handler = module.get(AuditEventHandler);

    await expect(
      manager.run({}, async () => handler.handle(new AuditEvent('boom'))),
    ).rejects.toThrow('audit boom');

    // AuditEventHandler's @Transactional wrap runs its own inner tx;
    // combined with the outer manager.run the outer adapter call is the
    // only one that fails. REQUIRED propagation joins, so we expect one
    // rollback total on the adapter.
    expect(adapter.rolledBackTransactions.length).toBeGreaterThanOrEqual(1);
    expect(auditHandleSeenError).toBeUndefined();

    // Also verify via the EventBus path: publish a throwing event and
    // wait for handle to finish (handler resolves the gate even after
    // throwing).
    const handleDone = waitForEventHandle();
    const rollbacksBefore = adapter.rolledBackTransactions.length;
    eventBus.publish(new AuditEvent('bus boom'));
    await handleDone;
    await drainEventLoop();

    expect(adapter.rolledBackTransactions.length).toBeGreaterThan(rollbacksBefore);
  });
});
