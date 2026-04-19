import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';

import { WalletOperationEvent } from './events';
import { WALLET_REPOSITORY, type WalletRepository } from './wallet.repository';

/**
 * Domain service under test. `@Transactional()` opens the ambient
 * transaction; the balance update and the outbox publication commit
 * (or roll back) atomically.
 *
 * The service injects an interface (`WalletRepository`) under a DI
 * token — NOT a TypeORM `Repository` directly. That indirection is a
 * **deliberate testing-pattern choice**: the unit test substitutes a
 * Jest mock for the token without standing up TypeORM at all, while
 * the integration test wires the real TypeORM-backed implementation.
 *
 * It also illustrates a wider habit: code under test should not
 * depend on infrastructure types (`Repository`, `DataSource`,
 * `EntityManager`) when an interface owned by the domain is enough.
 */
@Injectable()
export class WalletService {
  constructor(
    @Inject(WALLET_REPOSITORY)
    private readonly wallets: WalletRepository,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async deposit(walletId: string, amount: number): Promise<void> {
    if (amount <= 0) {
      throw new Error('amount must be positive');
    }
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new Error(`wallet ${walletId} not found`);
    }
    const newBalance = wallet.balance + amount;
    await this.wallets.updateBalance(walletId, newBalance);
    await this.outbox.publish(
      new WalletOperationEvent(walletId, 'deposit', amount, newBalance),
    );
  }

  @Transactional()
  async withdraw(walletId: string, amount: number): Promise<void> {
    if (amount <= 0) {
      throw new Error('amount must be positive');
    }
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new Error(`wallet ${walletId} not found`);
    }
    if (wallet.balance < amount) {
      throw new Error(`insufficient funds in ${walletId}`);
    }
    const newBalance = wallet.balance - amount;
    await this.wallets.updateBalance(walletId, newBalance);
    await this.outbox.publish(
      new WalletOperationEvent(walletId, 'withdraw', amount, newBalance),
    );
  }
}
