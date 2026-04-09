import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { RefundRequestedEvent } from './refund-requested.event';

/**
 * Local listener for `RefundRequestedEvent`. Runs BEFORE the
 * externalizer (DD-019 ordering); always fires once per publication
 * regardless of broker reachability. Useful for in-process
 * bookkeeping that must happen even when downstream brokers are
 * unhealthy.
 */
@Injectable()
@OutboxEventsHandler({ events: [RefundRequestedEvent], id: 'RefundLedger.record' })
export class RefundLedgerHandler implements IOutboxEventHandler<RefundRequestedEvent> {
  private readonly logger = new Logger(RefundLedgerHandler.name);

  readonly handled: RefundRequestedEvent[] = [];

  async handle(event: RefundRequestedEvent): Promise<void> {
    this.logger.log(`Local: ledger entry for refund ${event.refundId}`);
    this.handled.push(event);
  }
}
