import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Global, Module } from '@nestjs/common';
import { type NewOutboxMessage, Outbox } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionalModule } from '@nestjs-transactional/core';
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';

import { WALLET_REPOSITORY, type WalletRepository } from '../src/wallet.repository.js';
import { WalletService } from '../src/wallet.service.js';

/**
 * **Tier 2: outbox-aware unit tests, no database.**
 *
 * The real `OutboxEventPublisher` runs, inside real `@Transactional`
 * transactions on the in-memory adapter, against a recording stand-in for
 * `@nestjs/outbox`'s `Outbox`. That shows what the service hands the
 * outbox: which messages, on which topic, with which payload, and that
 * nothing is handed over outside a transaction.
 *
 * What this tier cannot show is atomicity. Whether a message rolls back
 * with the wallet row is decided by the database transaction the store
 * writes through, so it is asserted where there is one: the integration
 * tier. A test here that "proved" it would be testing the stand-in.
 */
describe('WalletService (outbox unit, recording Outbox)', () => {
  let module: TestingModule;
  let service: WalletService;
  let walletRepo: jest.Mocked<WalletRepository>;
  let added: NewOutboxMessage[];

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    walletRepo = {
      findById: jest.fn(),
      updateBalance: jest.fn(),
    };
    added = [];

    @Global()
    @Module({
      providers: [
        {
          provide: Outbox,
          useValue: {
            add: (_tx: unknown, message: NewOutboxMessage) => {
              added.push(message);
              return message;
            },
            notify: () => undefined,
          },
        },
      ],
      exports: [Outbox],
    })
    class RecordingOutboxModule {}

    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          adapter: new InMemoryTransactionAdapter(),
          isGlobal: true,
          registerInterceptor: false,
        }),
        RecordingOutboxModule,
        TransactionalOutboxModule.forRoot({
          // The in-memory adapter's handle is not a TypeORM EntityManager,
          // so hand the outbox the handle itself.
          transactionResolver: (active) => active.handle,
        }),
      ],
      providers: [WalletService, { provide: WALLET_REPOSITORY, useValue: walletRepo }],
    }).compile();

    await module.init();
    service = module.get(WalletService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('adds one message per balance change, under the event class name', async () => {
    walletRepo.findById.mockResolvedValueOnce({ id: 'w-1', balance: 100 });
    await service.deposit('w-1', 25);

    walletRepo.findById.mockResolvedValueOnce({ id: 'w-1', balance: 125 });
    await service.deposit('w-1', 75);

    expect(added.map((m) => m.topic)).toEqual(['WalletOperationEvent', 'WalletOperationEvent']);
    expect(added.map((m) => (m.payload as { balanceAfter: number }).balanceAfter)).toEqual([
      125, 200,
    ]);
  });

  it('carries the event as the payload, and its type in a header', async () => {
    walletRepo.findById.mockResolvedValueOnce({ id: 'w-99', balance: 1_000 });
    await service.withdraw('w-99', 250);

    expect(added).toHaveLength(1);
    expect(added[0]!.payload).toMatchObject({
      walletId: 'w-99',
      type: 'withdraw',
      amount: 250,
      balanceAfter: 750,
    });
    expect(added[0]!.headers).toEqual({ 'x-event-type': 'WalletOperationEvent' });
  });

  it('adds nothing when the service rejects before publishing', async () => {
    walletRepo.findById.mockResolvedValueOnce({ id: 'w-x', balance: 10 });

    await expect(service.withdraw('w-x', 50)).rejects.toThrow('insufficient');

    expect(added).toEqual([]);
  });
});
