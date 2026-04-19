import 'reflect-metadata';

import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionalModule } from '@nestjs-transactional/core';
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';
import {
  type IOutboxEventHandler,
  OutboxEventsHandler,
  OutboxModule,
} from '@nestjs-transactional/outbox';
import {
  AssertablePublishedEvents,
  PublishedEvents,
} from '@nestjs-transactional/outbox/testing';

import { WalletOperationEvent } from '../src/events';
import { WalletService } from '../src/wallet.service';
import { WALLET_REPOSITORY, type WalletRepository } from '../src/wallet.repository';

/**
 * A no-op outbox listener so the publisher has somewhere to write
 * publications. `OutboxEventPublisher.publish` is a silent no-op
 * when no listener is registered for the event type — that is by
 * design (avoids buffering events nobody consumes), but it means
 * any unit test that wants to assert on the publication state must
 * register at least one listener for the event class.
 */
@Injectable()
@OutboxEventsHandler({ events: [WalletOperationEvent], id: 'test.audit' })
class TestAuditListener implements IOutboxEventHandler<WalletOperationEvent> {
  async handle(_event: WalletOperationEvent): Promise<void> {
    // Intentionally empty — we only need it to register a listener
    // id with the outbox registry. The test's PublishedEvents view
    // observes the publication row, not whether handle() was called.
  }
}

/**
 * **Tier 2: Outbox-aware unit tests with `InMemoryEventPublicationRepository`
 * + `AssertablePublishedEvents`.**
 *
 * `OutboxModule.forRoot({})` without an explicit `repository`
 * defaults to `InMemoryEventPublicationRepository` — there is no
 * configuration step to swap in the in-memory repo, just leave the
 * option off. Tests assert on the published events directly via
 * the `PublishedEvents` and `AssertablePublishedEvents` providers.
 *
 * This tier verifies what the outbox **received** from the service:
 * which events, in which order, with which payloads. The framework's
 * delivery machinery (workers, retries, archival) is NOT exercised
 * — that belongs to the integration tier.
 *
 * Both styles are demonstrated below: `PublishedEvents` for raw
 * predicates, `AssertablePublishedEvents` for fluent assertions
 * that read like prose.
 */
describe('WalletService (outbox unit, InMemoryEventPublicationRepository)', () => {
  let module: TestingModule;
  let service: WalletService;
  let walletRepo: jest.Mocked<WalletRepository>;
  let publishedEvents: PublishedEvents;
  let assertablePublishedEvents: AssertablePublishedEvents;

  beforeEach(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    walletRepo = {
      findById: jest.fn(),
      updateBalance: jest.fn(),
    };

    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          adapter: new InMemoryTransactionAdapter(),
          isGlobal: true,
          registerInterceptor: false,
        }),
        // No `repository` option — defaults to InMemoryEventPublicationRepository.
        OutboxModule.forRoot({}),
        OutboxModule.forFeature([WalletOperationEvent]),
      ],
      providers: [
        WalletService,
        TestAuditListener,
        PublishedEvents,
        AssertablePublishedEvents,
        { provide: WALLET_REPOSITORY, useValue: walletRepo },
      ],
    }).compile();

    await module.init();
    service = module.get(WalletService);
    publishedEvents = module.get(PublishedEvents);
    assertablePublishedEvents = module.get(AssertablePublishedEvents);
  });

  afterEach(async () => {
    await module.close();
  });

  it('PublishedEvents.ofType(...) — raw predicate-driven view', async () => {
    walletRepo.findById.mockResolvedValueOnce({ id: 'w-1', balance: 100 });
    await service.deposit('w-1', 25);

    walletRepo.findById.mockResolvedValueOnce({ id: 'w-1', balance: 125 });
    await service.deposit('w-1', 75);

    const view = publishedEvents.ofType(WalletOperationEvent);
    expect(await view.count()).toBe(2);

    const deposits = await view
      .matching((e) => e.type, 'deposit')
      .matching((e) => e.walletId, 'w-1')
      .get();
    expect(deposits).toHaveLength(2);
    expect(deposits.map((e) => e.balanceAfter)).toEqual([125, 200]);
  });

  it('AssertablePublishedEvents — fluent, throws PublishedEventsAssertionError on miss', async () => {
    walletRepo.findById.mockResolvedValueOnce({ id: 'w-99', balance: 1_000 });
    await service.withdraw('w-99', 250);

    // The fluent API reads naturally at the call site:
    (await assertablePublishedEvents.contains(WalletOperationEvent))
      .matching((e) => e.walletId, 'w-99')
      .matching((e) => e.type, 'withdraw')
      .hasSize(1);

    // doesNotContain is the negative-path counterpart — useful for
    // asserting "this branch did NOT publish anything."
    walletRepo.findById.mockResolvedValueOnce({ id: 'w-99', balance: 750 });
    await expect(service.withdraw('w-99', 99_999)).rejects.toThrow('insufficient');
    // The transaction rolled back — the InMemory repo's rollback
    // hook removed the publication. Net change: no new events.
    (await assertablePublishedEvents.contains(WalletOperationEvent))
      .matching((e) => e.walletId, 'w-99')
      .hasSize(1); // still just the original successful withdraw
  });

  it('rollback removes the publication: failure path leaves NO trace in PublishedEvents', async () => {
    walletRepo.findById.mockResolvedValueOnce({ id: 'w-x', balance: 10 });

    await expect(service.withdraw('w-x', 50)).rejects.toThrow('insufficient');

    // The InMemoryEventPublicationRepository registers an
    // afterRollback hook (see its JSDoc) that undoes the
    // `createAll` it performed. So the failed transaction's
    // publication never appears in PublishedEvents — same
    // visibility guarantee a real DB-backed outbox gives.
    const allRows = await publishedEvents.all();
    expect(allRows).toHaveLength(0);
  });
});
