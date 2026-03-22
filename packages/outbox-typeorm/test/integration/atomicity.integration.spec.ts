import { Global, Injectable, Logger, Module, type Provider } from '@nestjs/common';
import { getDataSourceToken, InjectRepository } from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import { Transactional, TransactionalModule } from '@nestjs-transactional/core';
import {
  type IOutboxEventHandler,
  OutboxEventPublisher,
  OutboxEventsHandler,
  OutboxModule,
  PublicationStatus,
} from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { Column, Entity, PrimaryColumn, Repository } from 'typeorm';

import { EventPublicationArchiveEntity } from '../../src/entity/event-publication-archive.entity';
import { EventPublicationEntity } from '../../src/entity/event-publication.entity';
import {
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '../../src/module/outbox-typeorm.module';
import {
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';

/**
 * Phase 14.21 atomicity verification — the critical regression net
 * for the outbox pattern's fundamental contract: business writes and
 * `event_publication` writes inside a `@Transactional()` method must
 * land in the SAME database transaction (atomic commit), and a thrown
 * error must roll BOTH back.
 *
 * Two transactional dispatch mechanisms cooperate here:
 *
 * 1. **Phase 14.20 patches** — `Repository.prototype.manager` getter
 *    on the `@InjectRepository`'d business Repository routes through
 *    the active transactional `EntityManager`.
 * 2. **`getCurrentEntityManager` in `TypeOrmEventPublicationRepository`**
 *    — explicitly looks up the active EM for outbox writes via
 *    `TransactionContext`.
 *
 * Both reach the SAME active EM through `TransactionContext` —
 * parallel doors to the same transaction. This test pins the contract
 * with real Postgres so future refactors that break either mechanism
 * surface as a regression.
 */

@Entity({ name: 'atomicity_users' })
class AtomicityUser {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;
}

class UserCreatedEvent {
  constructor(readonly userId: string) {}
}

@Injectable()
@OutboxEventsHandler({ events: [UserCreatedEvent], newTransaction: false })
class UserCreatedListener implements IOutboxEventHandler<UserCreatedEvent> {
  received: UserCreatedEvent[] = [];

  async handle(event: UserCreatedEvent): Promise<void> {
    this.received.push(event);
  }
}

@Injectable()
class UserService {
  constructor(
    @InjectRepository(AtomicityUser)
    private readonly userRepo: Repository<AtomicityUser>,
    private readonly publisher: OutboxEventPublisher,
  ) {}

  /**
   * Happy path: business INSERT through the Phase 14.20-patched
   * Repository, plus outbox INSERT through `OutboxEventPublisher`
   * (which fires the actual `event_publication` write at
   * before-commit time via the registry's flush hook). Both must
   * land in the same transaction.
   */
  @Transactional()
  async createUserWithEvent(id: string, name: string): Promise<void> {
    await this.userRepo.save({ id, name });
    await this.publisher.publish(new UserCreatedEvent(id));
  }

  /**
   * Forced rollback: identical to above, then throws. Atomicity
   * means NEITHER row should be persisted.
   */
  @Transactional()
  async createUserWithEventThenThrow(id: string, name: string): Promise<void> {
    await this.userRepo.save({ id, name });
    await this.publisher.publish(new UserCreatedEvent(id));
    throw new Error('forced rollback');
  }
}

/**
 * Stand-in for `TypeOrmModule.forRoot(...)` registering the
 * `getDataSourceToken()` provider in a `@Global()` module so
 * `TypeOrmTransactionalModule.forRoot` and the
 * `@InjectRepository(AtomicityUser)` factory can resolve it.
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

describe('Outbox + business INSERT atomicity (Phase 14.21, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;
  let app: TestingModule;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    ctx = await startPostgresContainer({
      entities: [AtomicityUser, EventPublicationEntity, EventPublicationArchiveEntity],
      synchronize: true,
    });

    app = await Test.createTestingModule({
      imports: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildFakeTypeOrmModule([
          { provide: getDataSourceToken(), useValue: ctx.dataSource },
          {
            // `@nestjs/typeorm`'s `@InjectRepository(AtomicityUser)`
            // resolves to a token derived from the entity name. We
            // wire it manually under the same convention so the
            // service can inject a real Repository.
            provide: 'AtomicityUserRepository',
            useFactory: (ds: typeof ctx.dataSource): Repository<AtomicityUser> =>
              ds.getRepository(AtomicityUser),
            inject: [getDataSourceToken()],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any,
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: true,
        }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        OutboxTypeOrmModule.forRoot(),
        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
        }),
        OutboxModule.forFeature([UserCreatedEvent]),
      ],
      providers: [UserService, UserCreatedListener],
    }).compile();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await ctx.dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await ctx.dataSource.getRepository(EventPublicationEntity).clear();
    await ctx.dataSource.getRepository(AtomicityUser).clear();
  });

  it('successful @Transactional commits BOTH the business row and the event_publication row in one transaction', async () => {
    const svc = app.get(UserService);
    await svc.createUserWithEvent('u-1', 'alice');

    const users = await ctx.dataSource.getRepository(AtomicityUser).find();
    const publications = await ctx.dataSource.getRepository(EventPublicationEntity).find();

    expect(users.map((u) => u.id)).toEqual(['u-1']);
    // Outbox row committed in the SAME transaction.
    expect(publications).toHaveLength(1);
    // Status PUBLISHED (not yet processed by the worker).
    expect(publications[0]!.status).toBe(PublicationStatus.PUBLISHED);
    expect(publications[0]!.eventType).toBe('UserCreatedEvent');
  });

  it('rollback in @Transactional discards BOTH the business row AND the event_publication row', async () => {
    const svc = app.get(UserService);

    await expect(
      svc.createUserWithEventThenThrow('u-2', 'bob'),
    ).rejects.toThrow('forced rollback');

    const users = await ctx.dataSource.getRepository(AtomicityUser).find();
    const publications = await ctx.dataSource.getRepository(EventPublicationEntity).find();

    // Neither row persists — both rolled back together. The proof
    // that outbox INSERT was inside the same transaction.
    expect(users).toHaveLength(0);
    expect(publications).toHaveLength(0);
  });

  it('multiple @Transactional methods run independently — each tx is its own atomic unit', async () => {
    const svc = app.get(UserService);

    await svc.createUserWithEvent('u-3', 'charlie');
    await expect(
      svc.createUserWithEventThenThrow('u-4', 'dani'),
    ).rejects.toThrow('forced rollback');
    await svc.createUserWithEvent('u-5', 'eve');

    const users = await ctx.dataSource.getRepository(AtomicityUser).find();
    const publications = await ctx.dataSource.getRepository(EventPublicationEntity).find();

    expect(users.map((u) => u.id).sort()).toEqual(['u-3', 'u-5']);
    expect(publications).toHaveLength(2);
    expect(
      publications.map((p) => JSON.parse(p.serializedEvent) as { userId: string }).map((e) => e.userId).sort(),
    ).toEqual(['u-3', 'u-5']);
  });
});
