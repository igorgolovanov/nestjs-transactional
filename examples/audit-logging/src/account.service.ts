import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { AccountOperationRow, AccountRow } from './entities';
import { AccountOperationEvent } from './events';

/**
 * Business service. Default `@Transactional()` opens the transaction
 * on the **business** DataSource — the only one this service ever
 * touches directly.
 *
 * Three writes commit atomically per call:
 *   1. `AccountRow.balance` update
 *   2. `AccountOperationRow` insert (durable record of the op)
 *   3. `event_publication` row from `OutboxEventPublisher.publish`
 *
 * Either ALL three commit or NONE do (DD-019). The audit DataSource
 * is not touched by this transaction at all — the audit handler
 * runs LATER, in a separate audit-DS transaction, after the worker
 * picks up the publication.
 */
@Injectable()
export class AccountService {
  constructor(
    @InjectRepository(AccountRow)
    private readonly accounts: Repository<AccountRow>,
    @InjectRepository(AccountOperationRow)
    private readonly operations: Repository<AccountOperationRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async deposit(accountId: string, operationId: string, amount: number): Promise<void> {
    const account = await this.accounts.findOneByOrFail({ id: accountId });
    const newBalance = account.balance + amount;
    await this.applyOperation(accountId, operationId, 'deposit', amount, newBalance);
  }

  @Transactional()
  async withdraw(accountId: string, operationId: string, amount: number): Promise<void> {
    const account = await this.accounts.findOneByOrFail({ id: accountId });
    if (account.balance < amount) {
      throw new Error(`insufficient funds in ${accountId}`);
    }
    const newBalance = account.balance - amount;
    await this.applyOperation(accountId, operationId, 'withdraw', amount, newBalance);
  }

  private async applyOperation(
    accountId: string,
    operationId: string,
    type: 'deposit' | 'withdraw',
    amount: number,
    balanceAfter: number,
  ): Promise<void> {
    await this.accounts.update(accountId, { balance: balanceAfter });
    await this.operations.insert({
      id: operationId,
      accountId,
      type,
      amount,
      balanceAfter,
      occurredAt: new Date(),
    });
    await this.outbox.publish(
      new AccountOperationEvent(operationId, accountId, type, amount, balanceAfter),
    );
  }
}
