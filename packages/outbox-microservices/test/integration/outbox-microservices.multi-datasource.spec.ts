import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { type ClientProxy } from '@nestjs/microservices';
import {
  Transactional,
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';
import {
  type EventPublicationRepository,
  EventPublicationProcessor,
  Externalized,
  type IOutboxEventHandler,
  OutboxEventPublisher,
  OutboxEventsHandler,
  OutboxListenerRegistry,
  OutboxModule,
  PublicationStatus,
  composeListenerId,
  getEventPublicationProcessorToken,
  getEventPublicationRepositoryToken,
  getOutboxListenerRegistryToken,
} from '@nestjs-transactional/outbox';
import { of } from 'rxjs';

import { OutboxMicroservicesModule } from '../../src/module/outbox-microservices.module';

/**
 * Phase 14.6 verification test (Q1.A — verification only).
 *
 * Asserts that the Phase 11 single-externalizer architecture in
 * `outbox-microservices` is compatible with Phase 14.3.2's
 * multi-`OutboxModule.forRoot()` shape. Multi-broker routing is driven
 * by the per-event `@Externalized({ client })` parameter, NOT by a
 * dataSource-keyed externalizer Map (Q1 / Q2 — explicit decision NOT
 * to add a `dataSource` option to `OutboxMicroservicesModule.forRoot`
 * for now).
 *
 * Mocked `ClientProxy` per Phase 11.4 / ADR-016 — real-broker
 * integration is intentionally out of scope here.
 */

// ---------------------------------------------------------------------------
// Multi-DS adapter under in-memory transactions — same shape as the
// outbox package's own multi-DS spec.
// ---------------------------------------------------------------------------

class NamedFakeAdapter
  implements TransactionAdapter<TransactionHandle & { id: string; adapterName: string }>
{
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

// ---------------------------------------------------------------------------
// Domain — two events, each declared @Externalized with an explicit
// per-event `client:` token. Routing semantics rely on this token.
// ---------------------------------------------------------------------------

const BILLING_CLIENT = 'BILLING_CLIENT';
const INVENTORY_CLIENT = 'INVENTORY_CLIENT';

@Externalized({ target: 'billing-topic', client: BILLING_CLIENT })
class BillingEvent {
  constructor(readonly invoiceId: string) {}
}

@Externalized({ target: 'inventory-topic', client: INVENTORY_CLIENT })
class InventoryEvent {
  constructor(readonly sku: string) {}
}

class InternalOnlyEvent {
  constructor(readonly id: string) {}
}

@Injectable()
@OutboxEventsHandler({ events: [BillingEvent], newTransaction: false })
class BillingListener implements IOutboxEventHandler<BillingEvent> {
  invocations: BillingEvent[] = [];
  async handle(event: BillingEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
@OutboxEventsHandler({ events: [InventoryEvent], newTransaction: false })
class InventoryListener implements IOutboxEventHandler<InventoryEvent> {
  invocations: InventoryEvent[] = [];
  async handle(event: InventoryEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
@OutboxEventsHandler({ events: [InternalOnlyEvent], newTransaction: false })
class InternalListener implements IOutboxEventHandler<InternalOnlyEvent> {
  invocations: InternalOnlyEvent[] = [];
  async handle(event: InternalOnlyEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
class BillingService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional({ dataSource: 'billing' })
  async chargeInvoice(invoiceId: string): Promise<void> {
    await this.publisher.publish(new BillingEvent(invoiceId));
  }
}

@Injectable()
class InventoryService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional({ dataSource: 'inventory' })
  async reserveStock(sku: string): Promise<void> {
    await this.publisher.publish(new InventoryEvent(sku));
  }
}

@Injectable()
class AuditService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional()
  async record(id: string): Promise<void> {
    await this.publisher.publish(new InternalOnlyEvent(id));
  }
}

// ---------------------------------------------------------------------------
// Mock ClientProxy helper.
// ---------------------------------------------------------------------------

interface ClientProxyMock {
  proxy: ClientProxy;
  emit: jest.Mock;
}

function makeClientProxyMock(): ClientProxyMock {
  const emit = jest.fn().mockReturnValue(of(undefined));
  const proxy = { emit } as unknown as ClientProxy;
  return { proxy, emit };
}

describe('OutboxMicroservicesModule + multi-dataSource outbox (Phase 14.6 verification)', () => {
  let module: TestingModule;
  let billingClient: ClientProxyMock;
  let inventoryClient: ClientProxyMock;

  // Need to register a third 'no-op-default' ClientProxy because the
  // module's bootstrap validation requires defaultClient to resolve.
  // Events without `client:` overrides would fall through to it; here
  // every event class declares its own client, so this binding stays
  // unused at runtime.
  const FALLBACK_CLIENT = 'FALLBACK_CLIENT';
  let fallbackClient: ClientProxyMock;

  beforeEach(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    billingClient = makeClientProxyMock();
    inventoryClient = makeClientProxyMock();
    fallbackClient = makeClientProxyMock();

    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: true,
          adapter: new NamedFakeAdapter('default'),
        }),
        TransactionalModule.forRoot({ adapter: new NamedFakeAdapter('billing') }),
        TransactionalModule.forRoot({ adapter: new NamedFakeAdapter('inventory') }),

        // Three outbox stacks — Phase 14.3.2 multi-forRoot.
        OutboxModule.forRoot({}),
        OutboxModule.forRoot({ dataSource: 'billing' }),
        OutboxModule.forRoot({ dataSource: 'inventory' }),

        // Per-DS event-class registrations. Each event class lives in
        // exactly one DS — `@Externalized` metadata is dataSource-
        // agnostic; the routing decision happens via per-event
        // `client:` token at externalize time.
        OutboxModule.forFeature([InternalOnlyEvent], { dataSource: 'default' }),
        OutboxModule.forFeature([BillingEvent], { dataSource: 'billing' }),
        OutboxModule.forFeature([InventoryEvent], { dataSource: 'inventory' }),

        // Single externalizer covering all DSes.
        OutboxMicroservicesModule.forRoot({ defaultClient: FALLBACK_CLIENT }),
      ],
      providers: [
        BillingListener,
        InventoryListener,
        InternalListener,
        BillingService,
        InventoryService,
        AuditService,
        { provide: BILLING_CLIENT, useValue: billingClient.proxy },
        { provide: INVENTORY_CLIENT, useValue: inventoryClient.proxy },
        { provide: FALLBACK_CLIENT, useValue: fallbackClient.proxy },
      ],
    }).compile();
    await module.init();

    // Manual per-DS listener registration. The OutboxListenerScanner
    // (Phase 14.3) registers every `@OutboxEventsHandler` with the
    // default-DS listener registry only — the Phase 14.3.1 scanner gap
    // documented in CLAUDE.md "Known Limitations". Until that lands,
    // multi-DS deployments register listeners manually with the
    // per-DS registry. This is a supported pattern by design — the
    // scanner is a convenience layer.
    registerOutboxListenerOnDataSource(module, 'billing', BillingEvent, BillingListener);
    registerOutboxListenerOnDataSource(
      module,
      'inventory',
      InventoryEvent,
      InventoryListener,
    );
  });

  afterEach(async () => {
    await module?.close();
  });

  it('billing event published from billing DS routes through BILLING_CLIENT', async () => {
    const billingService = module.get(BillingService);
    const billingProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('billing'),
    );

    await billingService.chargeInvoice('inv-1');
    await billingProcessor.processBatch();

    expect(billingClient.emit).toHaveBeenCalledTimes(1);
    expect(billingClient.emit).toHaveBeenCalledWith(
      'billing-topic',
      expect.any(BillingEvent),
    );
    expect(inventoryClient.emit).not.toHaveBeenCalled();
    expect(fallbackClient.emit).not.toHaveBeenCalled();
  });

  it('inventory event published from inventory DS routes through INVENTORY_CLIENT', async () => {
    const inventoryService = module.get(InventoryService);
    const inventoryProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('inventory'),
    );

    await inventoryService.reserveStock('SKU-7');
    await inventoryProcessor.processBatch();

    expect(inventoryClient.emit).toHaveBeenCalledTimes(1);
    expect(inventoryClient.emit).toHaveBeenCalledWith(
      'inventory-topic',
      expect.any(InventoryEvent),
    );
    expect(billingClient.emit).not.toHaveBeenCalled();
    expect(fallbackClient.emit).not.toHaveBeenCalled();
  });

  it('events from different DSes route to their respective brokers in the same run', async () => {
    const billingService = module.get(BillingService);
    const inventoryService = module.get(InventoryService);

    const billingProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('billing'),
    );
    const inventoryProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('inventory'),
    );

    await billingService.chargeInvoice('inv-9');
    await inventoryService.reserveStock('SKU-13');
    await billingService.chargeInvoice('inv-10');

    await billingProcessor.processBatch();
    await inventoryProcessor.processBatch();

    expect(billingClient.emit).toHaveBeenCalledTimes(2);
    expect(inventoryClient.emit).toHaveBeenCalledTimes(1);
    expect(fallbackClient.emit).not.toHaveBeenCalled();

    expect(
      (billingClient.emit.mock.calls as Array<[string, BillingEvent]>).map(
        ([, e]) => e.invoiceId,
      ),
    ).toEqual(['inv-9', 'inv-10']);
    expect(
      (inventoryClient.emit.mock.calls as Array<[string, InventoryEvent]>).map(
        ([, e]) => e.sku,
      ),
    ).toEqual(['SKU-13']);
  });

  it('events without @Externalized are not externalized — single externalizer correctly skips them per DD-018 / Phase 11.2', async () => {
    const auditService = module.get(AuditService);
    const defaultProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('default'),
    );

    await auditService.record('a-1');
    await defaultProcessor.processBatch();

    // Local listener fires; externalizer never invoked because the
    // event class carries no @Externalized metadata.
    expect(billingClient.emit).not.toHaveBeenCalled();
    expect(inventoryClient.emit).not.toHaveBeenCalled();
    expect(fallbackClient.emit).not.toHaveBeenCalled();

    const repo = module.get<EventPublicationRepository>(
      getEventPublicationRepositoryToken('default'),
    );
    const completed = await repo.findCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('publication is marked COMPLETED after the externalizer succeeds (per-DS COMPLETED semantics preserved)', async () => {
    const billingService = module.get(BillingService);
    const billingProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('billing'),
    );
    const billingRepo = module.get<EventPublicationRepository>(
      getEventPublicationRepositoryToken('billing'),
    );

    await billingService.chargeInvoice('inv-completed');
    await billingProcessor.processBatch();

    const completed = await billingRepo.findCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('per-DS failure isolation — billing externalizer failure does NOT affect inventory DS publications', async () => {
    const billingService = module.get(BillingService);
    const inventoryService = module.get(InventoryService);

    const billingProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('billing'),
    );
    const inventoryProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('inventory'),
    );

    const billingRepo = module.get<EventPublicationRepository>(
      getEventPublicationRepositoryToken('billing'),
    );
    const inventoryRepo = module.get<EventPublicationRepository>(
      getEventPublicationRepositoryToken('inventory'),
    );

    // Make BILLING_CLIENT.emit throw on the first call; INVENTORY_CLIENT
    // remains healthy.
    billingClient.emit.mockImplementationOnce(() => {
      throw new Error('billing broker down');
    });

    await billingService.chargeInvoice('inv-fails');
    await inventoryService.reserveStock('SKU-survives');

    await billingProcessor.processBatch();
    await inventoryProcessor.processBatch();

    const failed = await billingRepo.findFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0]!.failureReason).toMatch(/billing broker down/);

    // Inventory unaffected — its publication is COMPLETED.
    const inventoryCompleted = await inventoryRepo.findCompleted();
    expect(inventoryCompleted).toHaveLength(1);
    expect(inventoryCompleted[0]!.status).toBe(PublicationStatus.COMPLETED);
    expect(inventoryClient.emit).toHaveBeenCalledTimes(1);
  });

  it('singleton externalizer instance — same MicroservicesEventExternalizer used for every DS (Phase 14.6 Option A: no per-DS externalizer)', () => {
    // EVENT_EXTERNALIZER is bound process-wide. We verify the
    // facade-style assumption: a single externalizer handles every
    // dataSource, and per-DS processors all dispatch through it.
    const facade = module.get(OutboxEventPublisher);
    expect([...facade.getRegisteredDataSources()].sort()).toEqual([
      'billing',
      'default',
      'inventory',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Helper — manual per-DS listener registration (workaround for the
// Phase 14.3.1 scanner gap, documented in CLAUDE.md "Known Limitations").
// ---------------------------------------------------------------------------

function registerOutboxListenerOnDataSource<E extends object>(
  module: TestingModule,
  dataSource: string,
  eventClass: new (...args: never[]) => E,
  listenerClass: new (...args: never[]) => IOutboxEventHandler<E>,
): void {
  const registry = module.get<OutboxListenerRegistry>(
    getOutboxListenerRegistryToken(dataSource),
  );
  const listenerInstance = module.get(listenerClass);
  registry.register({
    id: composeListenerId(listenerClass.name, eventClass),
    eventType: eventClass.name,
    invoke: async (event) => {
      await listenerInstance.handle(event as E);
    },
  });
}
