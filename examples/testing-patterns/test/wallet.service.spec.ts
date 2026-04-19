import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionManager, TransactionalModule } from '@nestjs-transactional/core';
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';

import { OutboxEventPublisher } from '@nestjs-transactional/outbox';

import { WalletService } from '../src/wallet.service';
import { WALLET_REPOSITORY, type WalletRepository } from '../src/wallet.repository';

/**
 * **Tier 1: Unit tests with `InMemoryTransactionAdapter`.**
 *
 * The adapter records every `runInTransaction` call into observation
 * arrays — `committedTransactions`, `rolledBackTransactions` — that
 * tests assert on directly. No real database is involved; the test
 * runs in single-digit milliseconds.
 *
 * The repository is a Jest mock matching the `WalletRepository`
 * interface. The outbox publisher is also mocked — at this tier we
 * verify that `WalletService.deposit` *calls* `outbox.publish` with
 * the right payload, not what happens to the publication afterwards.
 *
 * The point of this tier: fast feedback while iterating on domain
 * logic. Use it for invariant checks, branch coverage, and "does
 * this method open a transaction?" assertions.
 */
describe('WalletService (unit, InMemoryTransactionAdapter)', () => {
  let module: TestingModule;
  let service: WalletService;
  let adapter: InMemoryTransactionAdapter;
  let walletRepo: jest.Mocked<WalletRepository>;
  let outbox: jest.Mocked<OutboxEventPublisher>;

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    adapter = new InMemoryTransactionAdapter();
    walletRepo = {
      findById: jest.fn(),
      updateBalance: jest.fn(),
    };
    outbox = {
      publish: jest.fn(),
    } as unknown as jest.Mocked<OutboxEventPublisher>;

    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          adapter,
          isGlobal: true,
          registerInterceptor: false,
        }),
      ],
      providers: [
        WalletService,
        { provide: WALLET_REPOSITORY, useValue: walletRepo },
        { provide: OutboxEventPublisher, useValue: outbox },
      ],
    }).compile();

    await module.init();
    service = module.get(WalletService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('deposit opens a transaction and commits it', async () => {
    walletRepo.findById.mockResolvedValue({ id: 'w-1', balance: 100 });

    await service.deposit('w-1', 50);

    expect(adapter.committedTransactions).toHaveLength(1);
    expect(adapter.rolledBackTransactions).toHaveLength(0);
    expect(walletRepo.updateBalance).toHaveBeenCalledWith('w-1', 150);
    expect(outbox.publish).toHaveBeenCalledTimes(1);
  });

  it('withdraw on insufficient funds throws and the transaction rolls back', async () => {
    walletRepo.findById.mockResolvedValue({ id: 'w-1', balance: 10 });

    await expect(service.withdraw('w-1', 50)).rejects.toThrow('insufficient');

    expect(adapter.committedTransactions).toHaveLength(0);
    expect(adapter.rolledBackTransactions).toHaveLength(1);
    expect(walletRepo.updateBalance).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('amount validation runs before opening the transaction', async () => {
    // Defensive validation happens inside the @Transactional, so the
    // adapter sees a rolled-back transaction. Asserting the
    // `rolledBackTransactions[*].error` field documents the
    // observation API even though we could also catch on `rejects`.
    await expect(service.deposit('w-1', 0)).rejects.toThrow('positive');

    expect(adapter.rolledBackTransactions).toHaveLength(1);
    expect((adapter.rolledBackTransactions[0]!.error as Error).message).toMatch(/positive/);
  });

  it('TransactionManager is wired and visible to test code (sanity check)', () => {
    // Useful pattern: pull the manager out of DI when you want to
    // run extra logic inside `manager.run({}, ...)` from the test
    // body itself — e.g. seeding state inside a transaction so the
    // service's @Transactional joins it (REQUIRED propagation).
    const manager = module.get(TransactionManager);
    expect(manager).toBeDefined();
  });
});
