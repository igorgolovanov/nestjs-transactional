import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Global, Injectable, Logger, Module } from '@nestjs/common';
import {
  AggregateRoot,
  CommandBus,
  CommandHandler,
  EventPublisher,
  type ICommandHandler,
} from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  Transactional,
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';
import {
  EventPublicationProcessor,
  type IOutboxEventHandler,
  OutboxEventPublisher,
  OutboxEventsHandler,
  OutboxListenerRegistry,
  OutboxModule,
  composeListenerId,
  getEventPublicationProcessorToken,
  getEventPublicationRepositoryToken,
  getOutboxListenerRegistryToken,
} from '@nestjs-transactional/outbox';

import { TransactionalEventsHandler } from '../decorators/transactional-events-handler.decorator';
import { OUTBOX_PUBLICATION_SCHEDULER } from '../event-publisher/hybrid-event-publisher';
import { OUTBOX_LISTENER_REGISTRAR } from '../handlers/outbox-listener-registrar';
import type { ITransactionalEventHandler } from '../interfaces/transactional-event-handler.interface';

import { CqrsTransactionalModule } from './cqrs-transactional.module';

/**
 * Phase 14.7 verification — cqrs is dataSource-agnostic by design and
 * survives multi-`OutboxModule.forRoot()` (ADR-019) without any
 * source-level dependence on the outbox package. The decoupling
 * relies on two structural ports — {@link OUTBOX_PUBLICATION_SCHEDULER}
 * and {@link OUTBOX_LISTENER_REGISTRAR} — which the application
 * binds via `useExisting` to the smart-facade `OutboxEventPublisher`
 * and the per-DS `OutboxListenerRegistry` of the dataSource cqrs
 * should bridge to.
 *
 * Three things this spec asserts:
 *
 *  1. cqrs source code (`packages/cqrs/src`) imports nothing from
 *     `@nestjs-transactional/outbox` — the structural-port
 *     architecture is preserved at compile time.
 *  2. A single `CqrsTransactionalModule.forRoot()` co-exists with
 *     multiple `OutboxModule.forRoot()` calls and the AggregateRoot
 *     publish path drives publications into the correct per-DS
 *     repository (smart-facade routing).
 *  3. The same wiring resolves the per-DS `OutboxListenerRegistry`
 *     via the public token utility — multi-DS deployments register
 *     `@IntegrationEventsHandler` listeners against the right DS
 *     manually until the Phase 14.3.1 scanner-gap fix lands (see
 *     CLAUDE.md "Known Limitations (Phase 14)").
 */

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

class DefaultEvent {
  constructor(readonly id: string) {}
}

class BillingEvent {
  constructor(readonly invoiceId: string) {}
}

class DefaultOrder extends AggregateRoot {
  constructor(readonly id: string) {
    super();
  }
  place(): void {
    this.apply(new DefaultEvent(this.id));
  }
}

class BillingOrder extends AggregateRoot {
  constructor(readonly invoiceId: string) {
    super();
  }
  charge(): void {
    this.apply(new BillingEvent(this.invoiceId));
  }
}

class PlaceDefaultCommand {
  constructor(readonly id: string) {}
}

class PlaceBillingCommand {
  constructor(readonly invoiceId: string) {}
}

@CommandHandler(PlaceDefaultCommand)
@Injectable()
class PlaceDefaultHandler implements ICommandHandler<PlaceDefaultCommand, void> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(command: PlaceDefaultCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new DefaultOrder(command.id));
    order.place();
    order.commit();
  }
}

@CommandHandler(PlaceBillingCommand)
@Injectable()
class PlaceBillingHandler implements ICommandHandler<PlaceBillingCommand, void> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional({ dataSource: 'billing' })
  async execute(command: PlaceBillingCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new BillingOrder(command.invoiceId));
    order.charge();
    order.commit();
  }
}

/**
 * In-memory listener — fires on AFTER_COMMIT via the cqrs
 * dispatcher. DataSource-agnostic; the dispatcher's "first active
 * transaction" semantics are documented in
 * `event-dispatcher.ts` JSDoc.
 */
@Injectable()
@TransactionalEventsHandler(DefaultEvent, BillingEvent)
class InMemoryRecorder implements ITransactionalEventHandler<DefaultEvent | BillingEvent> {
  received: (DefaultEvent | BillingEvent)[] = [];
  handle(event: DefaultEvent | BillingEvent): void {
    this.received.push(event);
  }
}

/**
 * Persistent listeners — one per dataSource. The decorator marks
 * them; we register manually with the per-DS listener registry to
 * sidestep the Phase 14.3.1 scanner gap.
 */
@Injectable()
@OutboxEventsHandler({ events: [DefaultEvent], newTransaction: false })
class DefaultPersistentListener implements IOutboxEventHandler<DefaultEvent> {
  received: DefaultEvent[] = [];
  async handle(event: DefaultEvent): Promise<void> {
    this.received.push(event);
  }
}

@Injectable()
@OutboxEventsHandler({ events: [BillingEvent], newTransaction: false })
class BillingPersistentListener implements IOutboxEventHandler<BillingEvent> {
  received: BillingEvent[] = [];
  async handle(event: BillingEvent): Promise<void> {
    this.received.push(event);
  }
}

/**
 * Bridge module — binds the cqrs structural port for the
 * AggregateRoot publisher path. The listener registrar
 * (`OUTBOX_LISTENER_REGISTRAR`) is auto-bound by `OutboxModule.forRoot`
 * to `MultiDsOutboxListenerRegistrar` (Phase 14.3.1) — no manual
 * binding required.
 *
 * `@Global()` because the consumer (`HybridEventPublisher` inside
 * `CqrsTransactionalModule`) lives in another module's DI scope.
 */
@Global()
@Module({
  providers: [
    { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
  ],
  exports: [OUTBOX_PUBLICATION_SCHEDULER],
})
class OutboxCqrsBridge {}

describe('CqrsTransactionalModule + multi-dataSource outbox (Phase 14.7 decoupling)', () => {
  it('cqrs source imports nothing from @nestjs-transactional/outbox', () => {
    // Compile-time guard: the structural-port architecture relies on
    // cqrs source code never reaching across the package boundary
    // for outbox internals. A grep across `packages/cqrs/src` is
    // sufficient — TypeScript imports are textual, and the
    // `from '@nestjs-transactional/outbox'` form catches every
    // shape (named, namespace, default).
    const cqrsSrcFiles = collectTsFiles(join(__dirname, '..', '..', 'src'));
    const offenders: string[] = [];
    for (const file of cqrsSrcFiles) {
      const text = readFileSync(file, 'utf8');
      // Test files and this spec itself are allowed to import outbox
      // (this spec is in src/ and imports outbox by design).
      if (file.endsWith('.spec.ts')) continue;
      if (text.includes("from '@nestjs-transactional/outbox'")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe('runtime — single CqrsTransactionalModule.forRoot routes events through multi-DS outbox', () => {
    let module: TestingModule;
    let inMemoryRecorder: InMemoryRecorder;
    let defaultListener: DefaultPersistentListener;
    let billingListener: BillingPersistentListener;

    beforeEach(async () => {
      OutboxModule.resetForTesting();
      TransactionalModule.resetForTesting();

      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: true,
            adapter: new NamedFakeAdapter('default'),
          }),
          TransactionalModule.forRoot({ adapter: new NamedFakeAdapter('billing') }),

          // Two outbox stacks — ADR-019 multi-forRoot.
          OutboxModule.forRoot({}),
          OutboxModule.forRoot({ dataSource: 'billing' }),

          OutboxModule.forFeature([DefaultEvent], { dataSource: 'default' }),
          OutboxModule.forFeature([BillingEvent], { dataSource: 'billing' }),

          // Single CqrsTransactionalModule — DS-agnostic per Phase 14.7.
          CqrsTransactionalModule.forRoot(),

          OutboxCqrsBridge,
        ],
        providers: [
          PlaceDefaultHandler,
          PlaceBillingHandler,
          InMemoryRecorder,
          DefaultPersistentListener,
          BillingPersistentListener,
        ],
      }).compile();
      await module.init();

      inMemoryRecorder = module.get(InMemoryRecorder);
      defaultListener = module.get(DefaultPersistentListener);
      billingListener = module.get(BillingPersistentListener);

      // Phase 14.3.1 — `OutboxListenerScanner` auto-routes
      // `BillingPersistentListener` to the billing-DS registry by
      // walking the per-DS event-type registries. The pre-Phase-14.3.1
      // workaround (manual `billingRegistry.register(...)`) is gone —
      // it would now collide with the scanner's registration with a
      // `DuplicateListenerIdError`.
    });

    afterEach(async () => {
      await module?.close();
    });

    it('default-DS aggregate command writes a publication to the default-DS repository only', async () => {
      const commandBus = module.get(CommandBus);
      await commandBus.execute(new PlaceDefaultCommand('order-1'));
      await flushMicrotasks();

      // Hybrid publisher routed the AggregateRoot event to BOTH the
      // in-memory dispatcher (AFTER_COMMIT — already fired) AND the
      // outbox smart facade.
      expect(inMemoryRecorder.received.map((e) => e.constructor.name)).toEqual(['DefaultEvent']);

      const defaultProcessor = module.get<EventPublicationProcessor>(
        getEventPublicationProcessorToken('default'),
      );
      await defaultProcessor.processBatch();
      expect(defaultListener.received.map((e) => e.id)).toEqual(['order-1']);
      expect(billingListener.received).toHaveLength(0);

      const defaultRepo = module.get(getEventPublicationRepositoryToken('default'));
      const billingRepo = module.get(getEventPublicationRepositoryToken('billing'));
      const defaultCompleted = await (
        defaultRepo as { findCompleted: () => Promise<unknown[]> }
      ).findCompleted();
      const billingCompleted = await (
        billingRepo as { findCompleted: () => Promise<unknown[]> }
      ).findCompleted();
      expect(defaultCompleted).toHaveLength(1);
      expect(billingCompleted).toHaveLength(0);
    });

    it('billing-DS aggregate command writes a publication to the billing-DS repository only', async () => {
      const commandBus = module.get(CommandBus);
      await commandBus.execute(new PlaceBillingCommand('inv-42'));
      await flushMicrotasks();

      expect(inMemoryRecorder.received.map((e) => e.constructor.name)).toEqual(['BillingEvent']);

      const billingProcessor = module.get<EventPublicationProcessor>(
        getEventPublicationProcessorToken('billing'),
      );
      await billingProcessor.processBatch();
      expect(billingListener.received.map((e) => e.invoiceId)).toEqual(['inv-42']);
      expect(defaultListener.received).toHaveLength(0);

      const defaultRepo = module.get(getEventPublicationRepositoryToken('default'));
      const billingRepo = module.get(getEventPublicationRepositoryToken('billing'));
      const defaultIncomplete = await (
        defaultRepo as { findIncomplete: () => Promise<unknown[]> }
      ).findIncomplete();
      const billingIncomplete = await (
        billingRepo as { findIncomplete: () => Promise<unknown[]> }
      ).findIncomplete();
      // Default DS got nothing.
      expect(defaultIncomplete).toHaveLength(0);
      // Billing DS publication committed and was processed → no
      // longer incomplete.
      expect(billingIncomplete).toHaveLength(0);
    });

    it('mixed-DS aggregate commands route each event to its owning dataSource — smart facade decision', async () => {
      const commandBus = module.get(CommandBus);
      await commandBus.execute(new PlaceDefaultCommand('order-A'));
      await commandBus.execute(new PlaceBillingCommand('inv-A'));
      await flushMicrotasks();

      const defaultProcessor = module.get<EventPublicationProcessor>(
        getEventPublicationProcessorToken('default'),
      );
      const billingProcessor = module.get<EventPublicationProcessor>(
        getEventPublicationProcessorToken('billing'),
      );
      await defaultProcessor.processBatch();
      await billingProcessor.processBatch();

      expect(defaultListener.received.map((e) => e.id)).toEqual(['order-A']);
      expect(billingListener.received.map((e) => e.invoiceId)).toEqual(['inv-A']);
    });

    it('the cqrs structural ports stay decoupled — facade resolves through useExisting, not direct outbox import', () => {
      // The `OUTBOX_PUBLICATION_SCHEDULER` symbol lives in
      // `packages/cqrs/src/event-publisher/hybrid-event-publisher.ts`.
      // The bridge module aliases it to `OutboxEventPublisher` (a
      // class from outbox). The fact that this resolves at all
      // proves the structural-port wiring works.
      const scheduler = module.get(OUTBOX_PUBLICATION_SCHEDULER);
      const facade = module.get(OutboxEventPublisher);
      expect(scheduler).toBe(facade);

      // Phase 14.3.1 — `OUTBOX_LISTENER_REGISTRAR` resolves to
      // outbox's `MultiDsOutboxListenerRegistrar` via `Symbol.for`
      // sharing (no source-level cqrs→outbox import). The class
      // identity is exposed only by structural shape — we test
      // behaviour: the registrar must possess a `register(...)`
      // method, and feeding it a billing event must land in the
      // billing-DS registry without further wiring.
      const registrar = module.get<{ register: (l: { id: string; eventType: string; invoke: (e: unknown) => Promise<void> }) => void }>(
        OUTBOX_LISTENER_REGISTRAR,
        { strict: false },
      );
      expect(typeof registrar.register).toBe('function');

      // Sanity check on the auto-routing: scanner already registered
      // BillingPersistentListener with the billing-DS registry.
      const billingRegistry = module.get<OutboxListenerRegistry>(
        getOutboxListenerRegistryToken('billing'),
      );
      const defaultRegistry = module.get<OutboxListenerRegistry>(
        getOutboxListenerRegistryToken('default'),
      );
      expect(
        billingRegistry.getById(
          composeListenerId(BillingPersistentListener.name, BillingEvent),
        ),
      ).toBeDefined();
      expect(
        defaultRegistry.getById(
          composeListenerId(BillingPersistentListener.name, BillingEvent),
        ),
      ).toBeUndefined();
    });
  });
});

/** Recursively collect `*.ts` files under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
