import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { QueryFailedError, Repository } from 'typeorm';

import { AuditLogRow } from './entities';
import { AccountOperationEvent } from './events';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Cross-DataSource audit consumer. The outbox worker (running on
 * the **business** DataSource — that's where `AccountOperationEvent`
 * is registered) picks up the publication and invokes this handler;
 * the handler then opens its own `@Transactional({ dataSource: 'audit' })`
 * to write into the audit database.
 *
 * Two DataSources, two transactions. There is no distributed
 * transaction across them and there is no need for one — the outbox
 * publication on the business side is the durable trigger; the
 * audit-side INSERT is the idempotent effect.
 *
 * `@InjectRepository(AuditLogRow, 'audit')` — the second argument
 * names the DataSource. Without it, `AuditLogRow` would resolve
 * against the default (business) DS where its table does not exist.
 *
 * Idempotency: `AuditLogRow.operationId` is the primary key. A
 * retried delivery surfaces as `unique_violation` and is treated
 * as a no-op. Without the gate, the audit log would gain duplicate
 * rows on every transient failure that did not propagate cleanly.
 */
@Injectable()
@IntegrationEventsHandler({ events: [AccountOperationEvent], id: 'Audit.LogOperation' })
export class AuditHandler implements IIntegrationEventHandler<AccountOperationEvent> {
  private readonly logger = new Logger(AuditHandler.name);

  constructor(
    @InjectRepository(AuditLogRow, 'audit')
    private readonly audit: Repository<AuditLogRow>,
  ) {}

  @Transactional({ dataSource: 'audit' })
  async handle(event: AccountOperationEvent): Promise<void> {
    try {
      await this.audit.insert({
        operationId: event.operationId,
        accountId: event.accountId,
        type: event.type,
        amount: event.amount,
        balanceAfter: event.balanceAfter,
        recordedAt: new Date(),
      });
    } catch (err) {
      if (
        err instanceof QueryFailedError &&
        (err.driverError as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION
      ) {
        this.logger.log(`Audit row for ${event.operationId} already exists — idempotent skip`);
        return;
      }
      throw err;
    }
  }
}
