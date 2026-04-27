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

import { OutboxEventsHandler } from '../decorators/outbox-events-handler.decorator';
import type { IOutboxEventHandler } from '../interfaces/outbox-event-handler.interface';

import { OutboxListenerRegistry } from './listener-registry';
import { OutboxListenerScanner } from './outbox-listener-scanner';

// Inline fake adapter — same pattern as elsewhere in the monorepo:
// `@nestjs-transactional/core/testing` cannot be imported cross-package
// under `moduleResolution: "node"`.
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

class PaymentCapturedEvent {
  constructor(readonly paymentId = 'pay-1') {}
}

@Injectable()
@OutboxEventsHandler(OrderPlacedEvent)
class OrderPlacedHandler implements IOutboxEventHandler<OrderPlacedEvent> {
  invocations: OrderPlacedEvent[] = [];
  async handle(event: OrderPlacedEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
@OutboxEventsHandler({ events: [PaymentCapturedEvent], id: 'custom-payment-id' })
class PaymentCapturedHandler implements IOutboxEventHandler<PaymentCapturedEvent> {
  async handle(_event: PaymentCapturedEvent): Promise<void> {}
}

@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], newTransaction: false })
class NoTxHandler implements IOutboxEventHandler<OrderPlacedEvent> {
  async handle(_event: OrderPlacedEvent): Promise<void> {}
}

@Injectable()
@OutboxEventsHandler(OrderPlacedEvent, PaymentCapturedEvent)
class MultiEventHandler
  implements IOutboxEventHandler<OrderPlacedEvent | PaymentCapturedEvent>
{
  invocations: (OrderPlacedEvent | PaymentCapturedEvent)[] = [];
  async handle(event: OrderPlacedEvent | PaymentCapturedEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
class UndecoratedService {
  doWork(): void {}
}

describe('OutboxListenerScanner', () => {
  let adapter: FakeAdapter;
  let module: TestingModule | undefined;
  let registry: OutboxListenerRegistry;

  async function build(extraProviders: unknown[]): Promise<void> {
    adapter = new FakeAdapter();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
    const transactionManager = new TransactionManager(adapterRegistry);

    module = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        { provide: TransactionManager, useValue: transactionManager },
        OutboxListenerRegistry,
        OutboxListenerScanner,
        ...(extraProviders as never[]),
      ],
    }).compile();

    await module.init();
    registry = module.get(OutboxListenerRegistry);
  }

  afterEach(async () => {
    try {
      await module?.close();
    } catch {
      // Swallow close errors — tests that force init to fail leave the
      // module in a half-initialised state that close cannot reliably
      // tear down. The unit here is the scanner, not Nest lifecycle.
    }
    module = undefined;
  });

  it('registers a decorated class under its event type', async () => {
    await build([OrderPlacedHandler]);

    const listeners = registry.getByEventType('OrderPlacedEvent');

    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.eventType).toBe('OrderPlacedEvent');
  });

  it('uses the explicit id option as the base for the listener id', async () => {
    await build([PaymentCapturedHandler]);

    const listener = registry.getById('custom-payment-id#PaymentCapturedEvent');
    expect(listener).toBeDefined();
    expect(listener!.eventType).toBe('PaymentCapturedEvent');
  });

  it('derives the default id from `${ClassName}#${EventName}` when no id option is given', async () => {
    await build([OrderPlacedHandler]);

    expect(registry.getById('OrderPlacedHandler#OrderPlacedEvent')).toBeDefined();
  });

  it('invokes a newTransaction=true handler inside a REQUIRES_NEW transaction', async () => {
    await build([OrderPlacedHandler]);

    const listener = registry.getById('OrderPlacedHandler#OrderPlacedEvent')!;
    await listener.invoke(new OrderPlacedEvent('order-99'));

    expect(adapter.committedTransactions).toHaveLength(1);
  });

  it('invokes a newTransaction=false handler without starting a transaction', async () => {
    await build([NoTxHandler]);

    const listener = registry.getById('NoTxHandler#OrderPlacedEvent')!;
    await listener.invoke(new OrderPlacedEvent('order-99'));

    expect(adapter.committedTransactions).toHaveLength(0);
  });

  it('registers one entry per event type for multi-event handlers', async () => {
    await build([MultiEventHandler]);

    const ids = registry.getAll().map((l) => l.id).sort();
    expect(ids).toEqual([
      'MultiEventHandler#OrderPlacedEvent',
      'MultiEventHandler#PaymentCapturedEvent',
    ]);
  });

  it('does not register plain providers', async () => {
    await build([OrderPlacedHandler, UndecoratedService]);

    const allIds = registry.getAll().map((l) => l.id);
    expect(allIds).toEqual(['OrderPlacedHandler#OrderPlacedEvent']);
  });

  it('binds `this` correctly — the handler can access instance state', async () => {
    await build([OrderPlacedHandler]);

    const decorated = module!.get(OrderPlacedHandler);
    const listener = registry.getById('OrderPlacedHandler#OrderPlacedEvent')!;
    const event = new OrderPlacedEvent('order-42');

    await listener.invoke(event);

    expect(decorated.invocations).toEqual([event]);
  });

  it('warns and skips a decorated class that does not expose `handle`', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    @Injectable()
    @OutboxEventsHandler(OrderPlacedEvent)
    class BrokenHandler {
      // intentionally no `handle` method
      doSomething(): void {}
    }

    await build([BrokenHandler]);

    expect(registry.getAll()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BrokenHandler'));
  });

  it('duplicate listener ids throw during registration', async () => {
    // Two handlers with the same explicit id would produce the same
    // suffix — colliding when registered with the registry.
    @Injectable()
    @OutboxEventsHandler({ events: [OrderPlacedEvent], id: 'shared-id' })
    class FirstHandler implements IOutboxEventHandler<OrderPlacedEvent> {
      async handle(_event: OrderPlacedEvent): Promise<void> {}
    }

    @Injectable()
    @OutboxEventsHandler({ events: [OrderPlacedEvent], id: 'shared-id' })
    class SecondHandler implements IOutboxEventHandler<OrderPlacedEvent> {
      async handle(_event: OrderPlacedEvent): Promise<void> {}
    }

    await expect(build([FirstHandler, SecondHandler])).rejects.toThrow(/shared-id/);
  });
});
