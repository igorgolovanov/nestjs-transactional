import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  AdapterRegistry,
  TransactionManager,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { ApplicationModuleHandler } from '../decorators/application-module-handler.decorator';
import {
  type DispatcherListenerMetadata,
  TransactionalEventDispatcher,
} from '../event-dispatcher/event-dispatcher';
import type { IApplicationModuleHandler } from '../interfaces/application-module-handler.interface';
import { TransactionPhase } from '../types/transactional-listener.types';

import { ApplicationModuleHandlerScanner } from './application-module-handler-scanner';
import {
  OUTBOX_LISTENER_REGISTRAR,
  type OutboxListenerRegistrar,
} from './outbox-listener-registrar';

interface FakeHandle extends TransactionHandle {
  readonly id: string;
  readonly adapterName: string;
}

class FakeAdapter implements TransactionAdapter<FakeHandle> {
  readonly name = 'in-memory';
  committedTransactions: FakeHandle[] = [];

  async runInTransaction<T>(
    _options: TransactionOptions,
    fn: (handle: FakeHandle) => Promise<T>,
  ): Promise<T> {
    const handle: FakeHandle = { id: randomUUID(), adapterName: this.name };
    const result = await fn(handle);
    this.committedTransactions.push(handle);
    return result;
  }

  async runInSavepoint<T>(
    parent: FakeHandle,
    fn: (handle: FakeHandle) => Promise<T>,
  ): Promise<T> {
    return fn(parent);
  }
}

class OrderPlacedEvent {
  constructor(readonly orderId = 'order-1') {}
}

class OrderCancelledEvent {
  constructor(readonly orderId = 'order-1') {}
}

@Injectable()
@ApplicationModuleHandler(OrderPlacedEvent)
class ShippingHandler implements IApplicationModuleHandler<OrderPlacedEvent> {
  invocations: OrderPlacedEvent[] = [];
  async handle(event: OrderPlacedEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
@ApplicationModuleHandler({ events: [OrderPlacedEvent], id: 'shipping.stable-id' })
class ShippingHandlerWithId implements IApplicationModuleHandler<OrderPlacedEvent> {
  async handle(_event: OrderPlacedEvent): Promise<void> {}
}

@Injectable()
@ApplicationModuleHandler(OrderPlacedEvent, OrderCancelledEvent)
class MultiEventHandler
  implements IApplicationModuleHandler<OrderPlacedEvent | OrderCancelledEvent>
{
  async handle(_event: OrderPlacedEvent | OrderCancelledEvent): Promise<void> {}
}

interface DispatcherRegisterCall {
  instance: object;
  methodName: string;
  metadata: DispatcherListenerMetadata;
}

describe('ApplicationModuleHandlerScanner', () => {
  let module: TestingModule | undefined;
  let adapter: FakeAdapter;
  let transactionManager: TransactionManager;

  async function build(options: {
    extraProviders: unknown[];
    withRegistrar?: OutboxListenerRegistrar;
  }): Promise<{ dispatcherCalls: DispatcherRegisterCall[] }> {
    adapter = new FakeAdapter();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
    transactionManager = new TransactionManager(adapterRegistry);

    const dispatcherCalls: DispatcherRegisterCall[] = [];
    // Spying on registerListener BEFORE the scanner runs needs a stable
    // dispatcher instance. We use a real dispatcher and patch the method
    // before the module is initialised by providing it via useFactory.
    const realDispatcher = new TransactionalEventDispatcher(transactionManager);
    const original = realDispatcher.registerListener.bind(realDispatcher);
    realDispatcher.registerListener = (
      instance: object,
      methodName: string,
      metadata: DispatcherListenerMetadata,
    ): void => {
      dispatcherCalls.push({ instance, methodName, metadata });
      original(instance, methodName, metadata);
    };

    const providers: unknown[] = [
      { provide: TransactionManager, useValue: transactionManager },
      { provide: TransactionalEventDispatcher, useValue: realDispatcher },
      ApplicationModuleHandlerScanner,
      ...options.extraProviders,
    ];
    if (options.withRegistrar !== undefined) {
      providers.push({ provide: OUTBOX_LISTENER_REGISTRAR, useValue: options.withRegistrar });
    }

    module = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: providers as never[],
    }).compile();

    await module.init();

    return { dispatcherCalls };
  }

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  describe('with outbox registrar bound', () => {
    let registrar: OutboxListenerRegistrar & { register: jest.Mock };

    beforeEach(() => {
      registrar = { register: jest.fn() };
    });

    it('registers the handler as an outbox listener, once per event type', async () => {
      await build({ extraProviders: [ShippingHandler], withRegistrar: registrar });

      expect(registrar.register).toHaveBeenCalledTimes(1);
      const [entry] = registrar.register.mock.calls[0] as [{ id: string; eventType: string }];
      expect(entry.eventType).toBe('OrderPlacedEvent');
      expect(entry.id).toBe('ShippingHandler#OrderPlacedEvent');
    });

    it('uses the explicit id as the base when provided', async () => {
      await build({
        extraProviders: [ShippingHandlerWithId],
        withRegistrar: registrar,
      });

      const [entry] = registrar.register.mock.calls[0] as [{ id: string }];
      expect(entry.id).toBe('shipping.stable-id#OrderPlacedEvent');
    });

    it('produces distinct listener ids for multi-event handlers', async () => {
      await build({ extraProviders: [MultiEventHandler], withRegistrar: registrar });

      expect(registrar.register).toHaveBeenCalledTimes(2);
      const ids = registrar.register.mock.calls.map(
        ([entry]: [{ id: string }]) => entry.id,
      );
      expect(ids).toEqual([
        'MultiEventHandler#OrderPlacedEvent',
        'MultiEventHandler#OrderCancelledEvent',
      ]);
    });

    it('invoke closure wraps the handler call in a new transaction', async () => {
      await build({ extraProviders: [ShippingHandler], withRegistrar: registrar });
      const handler = module!.get(ShippingHandler);

      const [entry] = registrar.register.mock.calls[0] as [
        { invoke: (event: unknown) => Promise<void> },
      ];
      const event = new OrderPlacedEvent('order-42');
      await entry.invoke(event);

      expect(handler.invocations).toEqual([event]);
      expect(adapter.committedTransactions).toHaveLength(1);
    });

    it('does not register with the in-memory dispatcher when the outbox is bound', async () => {
      const { dispatcherCalls } = await build({
        extraProviders: [ShippingHandler],
        withRegistrar: registrar,
      });

      expect(dispatcherCalls).toHaveLength(0);
    });
  });

  describe('without outbox registrar bound (in-memory fallback)', () => {
    it('registers the handler with the dispatcher as AFTER_COMMIT + async, once per event type', async () => {
      const { dispatcherCalls } = await build({ extraProviders: [ShippingHandler] });

      expect(dispatcherCalls).toHaveLength(1);
      const call = dispatcherCalls[0]!;
      expect(call.methodName).toBe('handle');
      expect(call.metadata.eventType).toBe(OrderPlacedEvent);
      expect(call.metadata.phase).toBe(TransactionPhase.AFTER_COMMIT);
      expect(call.metadata.async).toBe(true);
      expect(call.metadata.fallbackExecution).toBe(false);
    });

    it('registers one entry per event type for multi-event handlers', async () => {
      const { dispatcherCalls } = await build({ extraProviders: [MultiEventHandler] });

      expect(dispatcherCalls).toHaveLength(2);
      const eventTypes = dispatcherCalls.map((c) => c.metadata.eventType);
      expect(eventTypes).toContain(OrderPlacedEvent);
      expect(eventTypes).toContain(OrderCancelledEvent);
    });

    it('invokes the handler inside a fresh transaction after the outer commits', async () => {
      await build({ extraProviders: [ShippingHandler] });
      const dispatcher = module!.get(TransactionalEventDispatcher);
      const handler = module!.get(ShippingHandler);

      await transactionManager.run({}, async () => {
        dispatcher.scheduleDispatch(new OrderPlacedEvent('order-99'));
      });

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(handler.invocations.map((e) => e.orderId)).toEqual(['order-99']);
      // One outer commit + one inner (fresh) commit from the handler
      // wrapper. The inner commit is what matches outbox semantics.
      expect(adapter.committedTransactions.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('warns and skips a decorated class that does not expose `handle`', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    @Injectable()
    @ApplicationModuleHandler(OrderPlacedEvent)
    class BrokenHandler {
      doSomething(): void {}
    }

    const { dispatcherCalls } = await build({ extraProviders: [BrokenHandler] });

    expect(dispatcherCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BrokenHandler'));
  });
});
