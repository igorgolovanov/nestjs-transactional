import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  AdapterRegistry,
  TransactionManager,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { OutboxEventListener } from '../decorators/outbox-event-listener.decorator';

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
class DecoratedService {
  invocations: OrderPlacedEvent[] = [];

  @OutboxEventListener(OrderPlacedEvent)
  async onOrderPlaced(event: OrderPlacedEvent): Promise<void> {
    this.invocations.push(event);
  }

  @OutboxEventListener(PaymentCapturedEvent, { id: 'custom-payment-id' })
  async onPaymentCaptured(_event: PaymentCapturedEvent): Promise<void> {}

  plainMethod(): void {}
}

@Injectable()
class NoTxService {
  @OutboxEventListener(OrderPlacedEvent, { newTransaction: false })
  async onOrderPlacedNoTx(_event: OrderPlacedEvent): Promise<void> {}
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
    await module?.close();
    module = undefined;
  });

  it('registers a decorated method under its event type', async () => {
    await build([DecoratedService]);

    const listeners = registry.getByEventType('OrderPlacedEvent');

    expect(listeners).toHaveLength(1);
    expect(listeners[0]!.eventType).toBe('OrderPlacedEvent');
  });

  it('uses the explicit id from options when provided', async () => {
    await build([DecoratedService]);

    expect(registry.getById('custom-payment-id')).toBeDefined();
    expect(registry.getById('custom-payment-id')!.eventType).toBe('PaymentCapturedEvent');
  });

  it('derives the default id from `${ClassName}.${methodName}` when no id option is given', async () => {
    await build([DecoratedService]);

    expect(registry.getById('DecoratedService.onOrderPlaced')).toBeDefined();
  });

  it('invokes a newTransaction=true listener inside a REQUIRES_NEW transaction', async () => {
    await build([DecoratedService]);

    const listener = registry.getById('DecoratedService.onOrderPlaced')!;
    await listener.invoke(new OrderPlacedEvent('order-99'));

    expect(adapter.committedTransactions).toHaveLength(1);
  });

  it('invokes a newTransaction=false listener without starting a transaction', async () => {
    await build([NoTxService]);

    const listener = registry.getById('NoTxService.onOrderPlacedNoTx')!;
    await listener.invoke(new OrderPlacedEvent('order-99'));

    expect(adapter.committedTransactions).toHaveLength(0);
  });

  it('registers every decorated method on a service with multiple listeners', async () => {
    await build([DecoratedService]);

    const decoratedIds = registry.getAll().map((l) => l.id).sort();

    expect(decoratedIds).toEqual(['DecoratedService.onOrderPlaced', 'custom-payment-id']);
  });

  it('does not register methods without @OutboxEventListener or services that only have plain methods', async () => {
    await build([DecoratedService, UndecoratedService]);

    const allIds = registry.getAll().map((l) => l.id);

    expect(allIds).not.toContain('DecoratedService.plainMethod');
    expect(allIds).not.toContain('UndecoratedService.doWork');
  });

  it('binds `this` correctly — the listener can access instance state', async () => {
    await build([DecoratedService]);

    const decorated = module!.get(DecoratedService);
    const listener = registry.getById('DecoratedService.onOrderPlaced')!;
    const event = new OrderPlacedEvent('order-42');

    await listener.invoke(event);

    expect(decorated.invocations).toEqual([event]);
  });
});
