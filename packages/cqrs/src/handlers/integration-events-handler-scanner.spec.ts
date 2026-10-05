import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
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

import { IntegrationEventsHandler } from '../decorators/integration-events-handler.decorator.js';
import {
  type DispatcherListenerMetadata,
  TransactionalEventDispatcher,
} from '../event-dispatcher/event-dispatcher.js';
import type { IIntegrationEventHandler } from '../interfaces/integration-event-handler.interface.js';
import { TransactionPhase } from '../types/transactional-listener.types.js';

import { IntegrationEventsHandlerScanner } from './integration-events-handler-scanner.js';

interface FakeHandle extends TransactionHandle {
  readonly id: string;
  readonly adapterName: string;
}

class FakeAdapter implements TransactionAdapter<FakeHandle> {
  readonly name = 'in-memory';
  readonly dataSourceName = 'default';
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

  async runInSavepoint<T>(parent: FakeHandle, fn: (handle: FakeHandle) => Promise<T>): Promise<T> {
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
@IntegrationEventsHandler(OrderPlacedEvent)
class ShippingHandler implements IIntegrationEventHandler<OrderPlacedEvent> {
  invocations: OrderPlacedEvent[] = [];
  async handle(event: OrderPlacedEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
@IntegrationEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
class MultiEventHandler implements IIntegrationEventHandler<
  OrderPlacedEvent | OrderCancelledEvent
> {
  async handle(_event: OrderPlacedEvent | OrderCancelledEvent): Promise<void> {}
}

interface DispatcherRegisterCall {
  instance: object;
  methodName: string;
  metadata: DispatcherListenerMetadata;
}

describe('IntegrationEventsHandlerScanner', () => {
  let module: TestingModule | undefined;
  let adapter: FakeAdapter;
  let transactionManager: TransactionManager;

  async function build(options: {
    extraProviders: unknown[];
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
      IntegrationEventsHandlerScanner,
      ...options.extraProviders,
    ];

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

  describe('dispatcher registration', () => {
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
      // wrapper.
      expect(adapter.committedTransactions.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('warns and skips a decorated class that does not expose `handle`', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    @Injectable()
    @IntegrationEventsHandler(OrderPlacedEvent)
    class BrokenHandler {
      doSomething(): void {}
    }

    const { dispatcherCalls } = await build({ extraProviders: [BrokenHandler] });

    expect(dispatcherCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BrokenHandler'));
  });
});
