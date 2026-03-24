import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { OutboxModule } from '../module/outbox.module';
import { getOutboxListenerRegistryToken } from '../tokens/token-utils';

import type { OutboxListenerRegistry } from './listener-registry';
import {
  MultiDsOutboxListenerRegistrar,
  OUTBOX_LISTENER_REGISTRAR_TOKEN,
} from './multi-ds-listener-registrar';

class NamedFakeAdapter implements TransactionAdapter<TransactionHandle & { id: string; adapterName: string }> {
  readonly name = 'in-memory';
  constructor(readonly dataSourceName: string) {}

  async runInTransaction<T>(
    _options: TransactionOptions,
    fn: (handle: TransactionHandle & { id: string; adapterName: string }) => Promise<T>,
  ): Promise<T> {
    return fn({ id: randomUUID(), adapterName: this.name });
  }

  async runInSavepoint<T>(
    parent: TransactionHandle & { id: string; adapterName: string },
    fn: (handle: TransactionHandle & { id: string; adapterName: string }) => Promise<T>,
  ): Promise<T> {
    return fn(parent);
  }
}

class DefaultEvent {}
class BillingEvent {}
class InventoryEvent {}

describe('MultiDsOutboxListenerRegistrar', () => {
  let module: TestingModule;
  let registrar: MultiDsOutboxListenerRegistrar;

  beforeEach(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    module = await Test.createTestingModule({
      imports: [
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
        OutboxModule.forRoot({}),
        OutboxModule.forRoot({ dataSource: 'billing' }),
        OutboxModule.forRoot({ dataSource: 'inventory' }),
        OutboxModule.forFeature([DefaultEvent]),
        OutboxModule.forFeature([BillingEvent], { dataSource: 'billing' }),
        OutboxModule.forFeature([InventoryEvent], { dataSource: 'inventory' }),
      ],
    }).compile();

    await module.init();

    registrar = module.get(MultiDsOutboxListenerRegistrar);
  });

  afterEach(async () => {
    await module.close();
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
  });

  it('routes a listener to the per-DS registry that owns the event class', () => {
    const invoke = jest.fn(async () => {});

    registrar.register({
      id: 'BillingHandler#BillingEvent',
      eventType: 'BillingEvent',
      invoke,
    });

    const billingRegistry = module.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('billing'),
      { strict: false },
    );
    expect(billingRegistry.getById('BillingHandler#BillingEvent')).toBeDefined();

    // Verify other registries are untouched.
    const defaultRegistry = module.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('default'),
      { strict: false },
    );
    expect(defaultRegistry.getAll()).toHaveLength(0);
    const inventoryRegistry = module.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('inventory'),
      { strict: false },
    );
    expect(inventoryRegistry.getAll()).toHaveLength(0);
  });

  it('routes a default-DS event to the default-DS registry', () => {
    registrar.register({
      id: 'DefaultHandler#DefaultEvent',
      eventType: 'DefaultEvent',
      invoke: async () => {},
    });

    const defaultRegistry = module.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('default'),
      { strict: false },
    );
    expect(defaultRegistry.getById('DefaultHandler#DefaultEvent')).toBeDefined();
  });

  it('throws OutboxError when the event-type is not registered in any dataSource', () => {
    expect(() =>
      registrar.register({
        id: 'X#UnregisteredEvent',
        eventType: 'UnregisteredEvent',
        invoke: async () => {},
      }),
    ).toThrow(/UnregisteredEvent.*not registered/s);
  });

  it('preserves the listener invoke closure end-to-end', async () => {
    const invocations: unknown[] = [];
    const invoke = async (event: unknown): Promise<void> => {
      invocations.push(event);
    };

    registrar.register({
      id: 'BillingHandler#BillingEvent',
      eventType: 'BillingEvent',
      invoke,
    });

    const billingRegistry = module.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('billing'),
      { strict: false },
    );
    const entry = billingRegistry.getByEventType('BillingEvent')[0]!;
    const event = new BillingEvent();
    await entry.invoke(event);

    expect(invocations).toEqual([event]);
  });

  it('OUTBOX_LISTENER_REGISTRAR_TOKEN aliases to the same registrar instance', () => {
    const viaAlias = module.get<MultiDsOutboxListenerRegistrar>(
      OUTBOX_LISTENER_REGISTRAR_TOKEN,
      { strict: false },
    );
    expect(viaAlias).toBe(registrar);
  });

  it('Symbol.for sharing — token identity matches the cqrs side declaration', () => {
    // Cqrs declares Symbol.for('@nestjs-transactional/cqrs/outbox-listener-registrar')
    // — verifying via the well-known key here proves cross-package
    // identity without an actual cqrs import.
    const expected = Symbol.for('@nestjs-transactional/cqrs/outbox-listener-registrar');
    expect(OUTBOX_LISTENER_REGISTRAR_TOKEN).toBe(expected);
  });
});
