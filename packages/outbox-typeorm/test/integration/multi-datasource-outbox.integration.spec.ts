import { Global, Injectable, Logger, Module, type Provider } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import { Transactional, TransactionalModule } from '@nestjs-transactional/core';
import {
  EventPublicationProcessor,
  OutboxEventPublisher,
  OutboxListenerRegistry,
  OutboxModule,
  PublicationStatus,
  composeListenerId,
  getEventPublicationProcessorToken,
  getEventPublicationRepositoryToken,
  getOutboxListenerRegistryToken,
} from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import type { DataSource } from 'typeorm';

import { EventPublicationArchiveEntity } from '../../src/entity/event-publication-archive.entity';
import { EventPublicationEntity } from '../../src/entity/event-publication.entity';
import {
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '../../src/module/outbox-typeorm.module';
import { TypeOrmEventPublicationRepository } from '../../src/repository/typeorm-event-publication.repository';
import {
  type PostgresTestContext,
  createAdditionalDatabase,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';

/**
 * Phase 14.20: stand-in for `TypeOrmModule.forRoot(...)` registers
 * the per-DS `getDataSourceToken(name)` providers in a `@Global()`
 * module so `TypeOrmTransactionalModule.forRoot` can resolve them.
 */
function buildFakeTypeOrmModule(providers: Provider[]): unknown {
  @Global()
  @Module({
    providers,
    exports: providers.map((p) => (typeof p === 'object' && 'provide' in p ? p.provide : p)),
  })
  class FakeTypeOrmModule {}
  return FakeTypeOrmModule;
}

class DefaultEvent {
  constructor(readonly id: string) {}
}

class BillingEvent {
  constructor(readonly invoiceId: string) {}
}

@Injectable()
class DefaultService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional()
  async produce(id: string): Promise<void> {
    await this.publisher.publish(new DefaultEvent(id));
  }
}

@Injectable()
class BillingService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional({ dataSource: 'billing' })
  async produce(invoiceId: string): Promise<void> {
    await this.publisher.publish(new BillingEvent(invoiceId));
  }

  @Transactional({ dataSource: 'billing' })
  async produceAndFail(invoiceId: string): Promise<void> {
    await this.publisher.publish(new BillingEvent(invoiceId));
    throw new Error('force billing rollback');
  }
}

/**
 * NOTE — Phase 14.5 multi-DS test deliberately uses **manual**
 * per-DS listener registration rather than `@OutboxEventsHandler`.
 *
 * Phase 14.3 design gap: `OutboxListenerScanner` injects
 * `OutboxListenerRegistry` by class token, which is aliased only to
 * the `'default'` dataSource's registry. Decorator-driven scanning
 * therefore registers *every* `@OutboxEventsHandler` with the
 * default-DS registry regardless of which dataSource owns the events
 * the handler subscribes to. Multi-DS deployments needing
 * non-default-DS listener routing must — until Phase 14.3.1 lands —
 * register listeners manually:
 *
 * ```ts
 * const registry = app.get(getOutboxListenerRegistryToken('billing'));
 * registry.register({ id, eventType, invoke });
 * ```
 *
 * This is also a legitimate real-world usage pattern (programmatic
 * registration is supported by design — the scanner is a
 * convenience). See `docs/known-limitations.md` and the planned
 * Phase 14.3.1 in `docs/roadmap/README.md`.
 */
describe('OutboxTypeOrmModule multi-dataSource (integration, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;
  let billingDs: DataSource;

  let app: TestingModule;
  let defaultService: DefaultService;
  let billingService: BillingService;

  const defaultReceived: DefaultEvent[] = [];
  const billingReceived: BillingEvent[] = [];

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    ctx = await startPostgresContainer({
      entities: [EventPublicationEntity, EventPublicationArchiveEntity],
      synchronize: true,
    });
    billingDs = await createAdditionalDatabase(ctx, 'outbox_billing_test', {
      entities: [EventPublicationEntity, EventPublicationArchiveEntity],
      synchronize: true,
    });

    app = await Test.createTestingModule({
      imports: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildFakeTypeOrmModule([
          { provide: getDataSourceToken(), useValue: ctx.dataSource },
          { provide: getDataSourceToken('billing'), useValue: billingDs },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any,
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: true,
        }),
        // Two TypeORM adapters under distinct dataSource names. The
        // first omits `dataSource` to exercise the implicit
        // `'default'` behaviour; the second passes it explicitly.
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }),
        // Two outbox-typeorm forRoot calls — the 'default' one omits
        // `dataSource` to verify the implicit default behaviour;
        // the 'billing' one passes it explicitly. Each resolves the
        // actual DataSource via @nestjs/typeorm getDataSourceToken.
        OutboxTypeOrmModule.forRoot(),
        OutboxTypeOrmModule.forRoot({ dataSource: 'billing' }),
        // Outbox multi-dataSource configuration (ADR-019 multi-forRoot
        // pattern). One forRoot per dataSource, each with its own
        // repository aliased to the per-DS TypeORM repository.
        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
        }),
        OutboxModule.forRoot({
          dataSource: 'billing',
          repository: typeOrmEventPublicationRepositoryProvider('billing'),
        }),
        // Per-DS event-class registrations.
        OutboxModule.forFeature([DefaultEvent], { dataSource: 'default' }),
        OutboxModule.forFeature([BillingEvent], { dataSource: 'billing' }),
      ],
      providers: [DefaultService, BillingService],
    }).compile();
    await app.init();

    defaultService = app.get(DefaultService);
    billingService = app.get(BillingService);

    // ---- Manual per-DS listener registration (see file-level NOTE) ----
    const defaultRegistry = app.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('default'),
    );
    defaultRegistry.register({
      id: composeListenerId('DefaultListener', DefaultEvent),
      eventType: DefaultEvent.name,
      invoke: async (event) => {
        defaultReceived.push(event as DefaultEvent);
      },
    });

    const billingRegistry = app.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('billing'),
    );
    billingRegistry.register({
      id: composeListenerId('BillingListener', BillingEvent),
      eventType: BillingEvent.name,
      invoke: async (event) => {
        billingReceived.push(event as BillingEvent);
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await billingDs.destroy();
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    // Reset only the static flag/Map so probe-style tests building
    // their own modules below see fresh "first call" behaviour. The
    // shared `app` module built in beforeAll is already wired and
    // unaffected by this reset.
    TransactionalModule.resetForTesting();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    defaultReceived.length = 0;
    billingReceived.length = 0;

    await ctx.dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await ctx.dataSource.getRepository(EventPublicationEntity).clear();
    await billingDs.getRepository(EventPublicationArchiveEntity).clear();
    await billingDs.getRepository(EventPublicationEntity).clear();
  });

  it('registers separate TypeOrmEventPublicationRepository instances per dataSource via the outbox per-DS tokens', async () => {
    const defaultRepo = app.get<TypeOrmEventPublicationRepository>(
      getEventPublicationRepositoryToken('default'),
    );
    const billingRepo = app.get<TypeOrmEventPublicationRepository>(
      getEventPublicationRepositoryToken('billing'),
    );

    expect(defaultRepo).toBeInstanceOf(TypeOrmEventPublicationRepository);
    expect(billingRepo).toBeInstanceOf(TypeOrmEventPublicationRepository);
    // Different instances — proves multi-DS registration produced
    // distinct repositories rather than a single class-token singleton.
    expect(defaultRepo).not.toBe(billingRepo);
  });

  it('publication for a default-DS event lands in the default-DS event_publication table only', async () => {
    await defaultService.produce('evt-1');

    const defaultRows = await ctx.dataSource.getRepository(EventPublicationEntity).find();
    const billingRows = await billingDs.getRepository(EventPublicationEntity).find();

    expect(defaultRows).toHaveLength(1);
    expect(defaultRows[0]!.eventType).toBe('DefaultEvent');
    expect(defaultRows[0]!.status).toBe(PublicationStatus.PUBLISHED);
    expect(billingRows).toHaveLength(0);
  });

  it('publication for a billing-DS event lands in the billing-DS event_publication table only', async () => {
    await billingService.produce('inv-42');

    const defaultRows = await ctx.dataSource.getRepository(EventPublicationEntity).find();
    const billingRows = await billingDs.getRepository(EventPublicationEntity).find();

    expect(billingRows).toHaveLength(1);
    expect(billingRows[0]!.eventType).toBe('BillingEvent');
    expect(billingRows[0]!.status).toBe(PublicationStatus.PUBLISHED);
    expect(defaultRows).toHaveLength(0);
  });

  it('per-DS processors deliver only their own publications and mark them COMPLETED', async () => {
    await defaultService.produce('evt-2');
    await billingService.produce('inv-43');

    const defaultProcessor = app.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('default'),
    );
    const billingProcessor = app.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('billing'),
    );

    await defaultProcessor.processBatch();
    expect(defaultReceived.map((e) => e.id)).toEqual(['evt-2']);
    expect(billingReceived).toHaveLength(0);

    await billingProcessor.processBatch();
    expect(billingReceived.map((e) => e.invoiceId)).toEqual(['inv-43']);

    const defaultRow = await ctx.dataSource
      .getRepository(EventPublicationEntity)
      .findOneOrFail({ where: {} });
    const billingRow = await billingDs
      .getRepository(EventPublicationEntity)
      .findOneOrFail({ where: {} });

    expect(defaultRow.status).toBe(PublicationStatus.COMPLETED);
    expect(billingRow.status).toBe(PublicationStatus.COMPLETED);
  });

  it('rollback on the billing dataSource leaves the default dataSource intact (cross-DS isolation per DD-023)', async () => {
    await defaultService.produce('evt-survives');

    await expect(billingService.produceAndFail('inv-rolls-back')).rejects.toThrow(
      'force billing rollback',
    );

    const defaultRows = await ctx.dataSource.getRepository(EventPublicationEntity).find();
    const billingRows = await billingDs.getRepository(EventPublicationEntity).find();

    // Default-DS publication is intact — billing's rollback does NOT
    // cascade across the dataSource boundary (DD-023).
    expect(defaultRows).toHaveLength(1);
    expect(defaultRows[0]!.eventType).toBe('DefaultEvent');
    // Billing-DS table is empty — the outbox row never committed.
    expect(billingRows).toHaveLength(0);
  });

  // Phase 14.21 removed the `dataSourceName` and `adapterInstance`
  // option fields entirely (both replaced by the unified `dataSource`
  // string identifier). The two tests that previously verified the
  // deprecated `adapterInstance` alias behaviour and its precedence
  // against `dataSourceName` are gone — neither field exists on
  // `OutboxTypeOrmOptions` anymore. The `dataSource` field's
  // happy-path use is exercised by the surrounding multi-DS tests
  // (default + 'billing').
});
