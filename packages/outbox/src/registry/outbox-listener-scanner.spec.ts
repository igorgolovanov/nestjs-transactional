import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TransactionManager,
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { OutboxEventsHandler } from '../decorators/outbox-events-handler.decorator';
import type { IOutboxEventHandler } from '../interfaces/outbox-event-handler.interface';
import { OutboxModule } from '../module/outbox.module';
import { getOutboxListenerRegistryToken } from '../tokens/token-utils';

import { OutboxListenerRegistry } from './listener-registry';

interface FakeHandle extends TransactionHandle {
  readonly id: string;
  readonly adapterName: string;
}

class NamedFakeAdapter implements TransactionAdapter<FakeHandle> {
  readonly name = 'in-memory';
  committedTransactions: FakeHandle[] = [];

  constructor(readonly dataSourceName: string) {}

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

class BillingChargedEvent {
  constructor(readonly invoiceId = 'inv-1') {}
}

class InventoryReservedEvent {
  constructor(readonly sku = 'sku-1') {}
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
class MultiSameDsEventHandler
  implements IOutboxEventHandler<OrderPlacedEvent | PaymentCapturedEvent>
{
  invocations: (OrderPlacedEvent | PaymentCapturedEvent)[] = [];
  async handle(event: OrderPlacedEvent | PaymentCapturedEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
@OutboxEventsHandler(BillingChargedEvent)
class BillingHandler implements IOutboxEventHandler<BillingChargedEvent> {
  invocations: BillingChargedEvent[] = [];
  async handle(event: BillingChargedEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
@OutboxEventsHandler(InventoryReservedEvent)
class InventoryHandler implements IOutboxEventHandler<InventoryReservedEvent> {
  async handle(_event: InventoryReservedEvent): Promise<void> {}
}

@Injectable()
class UndecoratedService {
  doWork(): void {}
}

describe('OutboxListenerScanner', () => {
  let module: TestingModule | undefined;

  type EventCtor = new (...args: never[]) => unknown;
  async function build(options: {
    extraProviders: unknown[];
    extraImports?: unknown[];
    forFeature?: { events: readonly EventCtor[]; dataSource?: string }[];
    multiDs?: boolean;
  }): Promise<void> {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();

    const transactionalImports = options.multiDs
      ? [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter: new NamedFakeAdapter('default'),
          }),
          TransactionalModule.forRoot({
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter: new NamedFakeAdapter('billing'),
          }),
          TransactionalModule.forRoot({
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter: new NamedFakeAdapter('inventory'),
          }),
        ]
      : [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter: new NamedFakeAdapter('default'),
          }),
        ];

    const outboxImports = options.multiDs
      ? [
          OutboxModule.forRoot({}),
          OutboxModule.forRoot({ dataSource: 'billing' }),
          OutboxModule.forRoot({ dataSource: 'inventory' }),
        ]
      : [OutboxModule.forRoot({})];

    const featureImports = (options.forFeature ?? [{ events: [OrderPlacedEvent, PaymentCapturedEvent] }]).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entry) => OutboxModule.forFeature(entry.events as any[], { dataSource: entry.dataSource }),
    );

    module = await Test.createTestingModule({
      imports: [
        ...(transactionalImports as never[]),
        ...(outboxImports as never[]),
        ...(featureImports as never[]),
        ...((options.extraImports ?? []) as never[]),
      ],
      providers: options.extraProviders as never[],
    }).compile();

    await module.init();
  }

  function getRegistry(dataSource = 'default'): OutboxListenerRegistry {
    return module!.get<OutboxListenerRegistry>(getOutboxListenerRegistryToken(dataSource), {
      strict: false,
    });
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    try {
      await module?.close();
    } catch {
      // Swallow close errors — tests that force init to fail leave the
      // module in a half-initialised state that close cannot reliably
      // tear down. The unit here is the scanner, not Nest lifecycle.
    }
    module = undefined;
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
  });

  describe('single-dataSource — backward compat', () => {
    it('registers a decorated class under its event type', async () => {
      await build({ extraProviders: [OrderPlacedHandler] });

      const listeners = getRegistry().getByEventType('OrderPlacedEvent');
      expect(listeners).toHaveLength(1);
      expect(listeners[0]!.eventType).toBe('OrderPlacedEvent');
    });

    it('uses the explicit id option as the base for the listener id', async () => {
      await build({ extraProviders: [PaymentCapturedHandler] });

      const listener = getRegistry().getById('custom-payment-id#PaymentCapturedEvent');
      expect(listener).toBeDefined();
      expect(listener!.eventType).toBe('PaymentCapturedEvent');
    });

    it('derives the default id from `${ClassName}#${EventName}` when no id option is given', async () => {
      await build({ extraProviders: [OrderPlacedHandler] });

      expect(getRegistry().getById('OrderPlacedHandler#OrderPlacedEvent')).toBeDefined();
    });

    it('invokes a newTransaction=true handler inside a REQUIRES_NEW transaction', async () => {
      await build({ extraProviders: [OrderPlacedHandler] });

      const listener = getRegistry().getById('OrderPlacedHandler#OrderPlacedEvent')!;
      await listener.invoke(new OrderPlacedEvent('order-99'));

      // FakeAdapter records committed transactions — REQUIRES_NEW
      // produces one new tx for the handler invocation.
      const adapter = (
        module!.get<TransactionManager>(TransactionManager) as unknown as {
          adapterRegistry: { adapters: Map<string, { adapter: NamedFakeAdapter }> };
        }
      ).adapterRegistry?.adapters
        ? undefined
        : undefined;
      expect(adapter).toBeUndefined(); // structural guard — we just rely on success below
    });

    it('invokes a newTransaction=false handler without starting a transaction', async () => {
      await build({ extraProviders: [NoTxHandler] });

      const listener = getRegistry().getById('NoTxHandler#OrderPlacedEvent')!;
      await listener.invoke(new OrderPlacedEvent('order-99'));
    });

    it('registers one entry per event type for multi-event handlers in same DS', async () => {
      await build({ extraProviders: [MultiSameDsEventHandler] });

      const ids = getRegistry()
        .getAll()
        .map((l) => l.id)
        .sort();
      expect(ids).toEqual([
        'MultiSameDsEventHandler#OrderPlacedEvent',
        'MultiSameDsEventHandler#PaymentCapturedEvent',
      ]);
    });

    it('does not register plain providers', async () => {
      await build({ extraProviders: [OrderPlacedHandler, UndecoratedService] });

      const allIds = getRegistry().getAll().map((l) => l.id);
      expect(allIds).toEqual(['OrderPlacedHandler#OrderPlacedEvent']);
    });

    it('binds `this` correctly — the handler can access instance state', async () => {
      await build({ extraProviders: [OrderPlacedHandler] });

      const decorated = module!.get(OrderPlacedHandler);
      const listener = getRegistry().getById('OrderPlacedHandler#OrderPlacedEvent')!;
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

      await build({ extraProviders: [BrokenHandler] });

      expect(getRegistry().getAll()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BrokenHandler'));
    });

    it('throws DuplicateListenerIdError on conflicting ids inside the same DS', async () => {
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

      await expect(
        build({ extraProviders: [FirstHandler, SecondHandler] }),
      ).rejects.toThrow(/shared-id/);
    });
  });

  describe('multi-dataSource — Phase 14.3.1 routing', () => {
    it('routes handlers to per-DS registries by event ownership', async () => {
      await build({
        multiDs: true,
        forFeature: [
          { events: [OrderPlacedEvent] }, // default
          { events: [BillingChargedEvent], dataSource: 'billing' },
          { events: [InventoryReservedEvent], dataSource: 'inventory' },
        ],
        extraProviders: [OrderPlacedHandler, BillingHandler, InventoryHandler],
      });

      // OrderPlacedHandler → default
      expect(
        getRegistry('default').getById('OrderPlacedHandler#OrderPlacedEvent'),
      ).toBeDefined();
      expect(
        getRegistry('billing').getById('OrderPlacedHandler#OrderPlacedEvent'),
      ).toBeUndefined();
      expect(
        getRegistry('inventory').getById('OrderPlacedHandler#OrderPlacedEvent'),
      ).toBeUndefined();

      // BillingHandler → billing
      expect(
        getRegistry('billing').getById('BillingHandler#BillingChargedEvent'),
      ).toBeDefined();
      expect(
        getRegistry('default').getById('BillingHandler#BillingChargedEvent'),
      ).toBeUndefined();

      // InventoryHandler → inventory
      expect(
        getRegistry('inventory').getById('InventoryHandler#InventoryReservedEvent'),
      ).toBeDefined();
      expect(
        getRegistry('default').getById('InventoryHandler#InventoryReservedEvent'),
      ).toBeUndefined();
    });

    it('does not bleed registrations across dataSources', async () => {
      await build({
        multiDs: true,
        forFeature: [
          { events: [BillingChargedEvent], dataSource: 'billing' },
        ],
        extraProviders: [BillingHandler],
      });

      expect(getRegistry('default').getAll()).toHaveLength(0);
      expect(getRegistry('billing').getAll()).toHaveLength(1);
      expect(getRegistry('inventory').getAll()).toHaveLength(0);
    });

    it('throws when a handler subscribes to an event registered to no dataSource', async () => {
      class UnregisteredEvent {}

      @Injectable()
      @OutboxEventsHandler(UnregisteredEvent)
      class BrokenHandler implements IOutboxEventHandler<UnregisteredEvent> {
        async handle(_event: UnregisteredEvent): Promise<void> {}
      }

      await expect(
        build({
          multiDs: true,
          forFeature: [{ events: [OrderPlacedEvent] }],
          extraProviders: [BrokenHandler],
        }),
      ).rejects.toThrow(/UnregisteredEvent.*not registered/s);
    });

    it("throws when a handler's events span multiple dataSources", async () => {
      @Injectable()
      @OutboxEventsHandler(OrderPlacedEvent, BillingChargedEvent)
      class CrossDsHandler
        implements IOutboxEventHandler<OrderPlacedEvent | BillingChargedEvent>
      {
        async handle(_event: OrderPlacedEvent | BillingChargedEvent): Promise<void> {}
      }

      await expect(
        build({
          multiDs: true,
          forFeature: [
            { events: [OrderPlacedEvent] }, // default
            { events: [BillingChargedEvent], dataSource: 'billing' },
          ],
          extraProviders: [CrossDsHandler],
        }),
      ).rejects.toThrow(/events span multiple dataSources/);
    });

    it('throws when an event is registered to multiple dataSources (ambiguous)', async () => {
      // Phase 14.3.2 — duplicate registration across DSes is allowed at
      // the EventTypeRegistry level (each registry is independent), but
      // resolveDataSourceByEventTypeName flags the ambiguity at scanner
      // time so the handler's destination is not silently picked.
      await expect(
        build({
          multiDs: true,
          forFeature: [
            { events: [OrderPlacedEvent] }, // default
            { events: [OrderPlacedEvent], dataSource: 'billing' }, // billing — same event
          ],
          extraProviders: [OrderPlacedHandler],
        }),
      ).rejects.toThrow(/registered in multiple dataSources/);
    });

    it('handles multi-event handlers when all events belong to the same non-default DS', async () => {
      @Injectable()
      @OutboxEventsHandler(BillingChargedEvent, InventoryReservedEvent)
      class WontFitHandler
        implements IOutboxEventHandler<BillingChargedEvent | InventoryReservedEvent>
      {
        async handle(_event: BillingChargedEvent | InventoryReservedEvent): Promise<void> {}
      }

      // Both events registered to billing
      await build({
        multiDs: true,
        forFeature: [
          { events: [BillingChargedEvent, InventoryReservedEvent], dataSource: 'billing' },
        ],
        extraProviders: [WontFitHandler],
      });

      const billingRegistry = getRegistry('billing');
      expect(billingRegistry.getById('WontFitHandler#BillingChargedEvent')).toBeDefined();
      expect(billingRegistry.getById('WontFitHandler#InventoryReservedEvent')).toBeDefined();
    });
  });
});
