import { Injectable, Logger } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { QueryFailedError, Repository } from 'typeorm';

import { AuditLogRow } from './entities.js';
import type { AccountOperationEvent } from './events.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Cross-DataSource audit consumer. `@nestjs/outbox`'s relay delivers
 * `AccountOperationEvent` from the business database's outbox to this
 * handler, which opens its own `@Transactional({ dataSource: 'audit' })`
 * to write into the audit database.
 *
 * Two DataSources, two transactions. There is no distributed
 * transaction across them and there is no need for one: the outbox
 * message on the business side is the durable trigger, and the
 * audit-side INSERT is the idempotent effect.
 *
 * `@InjectRepository(AuditLogRow, 'audit')`: the second argument names
 * the DataSource. Without it, `AuditLogRow` would resolve against the
 * default (business) DS where its table does not exist.
 *
 * Idempotency has two layers here. The handler's inbox (`consumer`)
 * skips a message it already completed, but it lives in the business
 * database and so cannot commit together with the audit row. The audit
 * row's primary key, `operationId`, closes that gap: a delivery that
 * wrote the row but crashed before its inbox record surfaces on the
 * retry as `unique_violation`, which is treated as a no-op.
 */
@Injectable()
export class AuditHandler {
  private readonly logger = new Logger(AuditHandler.name);

  constructor(
    @InjectRepository(AuditLogRow, 'audit')
    private readonly audit: Repository<AuditLogRow>,
  ) {}

  @OnOutboxMessage('AccountOperationEvent', { consumer: 'audit.log-operation' })
  @Transactional({ dataSource: 'audit' })
  async log(event: AccountOperationEvent): Promise<void> {
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
