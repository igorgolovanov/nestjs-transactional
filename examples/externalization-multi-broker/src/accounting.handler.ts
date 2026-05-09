import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { RefundRequestedEvent } from './refund-requested.event';

/**
 * Local listener for `RefundRequestedEvent`. Runs BEFORE the
 * externalizer dispatches to RabbitMQ. Useful for in-process
 * bookkeeping (e.g. record a pending refund row in a ledger table)
 * that should fire whether or not RabbitMQ is reachable.
 */
@Injectable()
@OutboxEventsHandler({ events: [RefundRequestedEvent], id: 'Accounting.recordRefund' })
export class AccountingHandler implements IOutboxEventHandler<RefundRequestedEvent> {
  private readonly logger = new Logger(AccountingHandler.name);

  readonly handled: RefundRequestedEvent[] = [];

  async handle(event: RefundRequestedEvent): Promise<void> {
    this.logger.log(
      `Local: recording refund ${event.refundId} for order ${event.orderId} (${event.amountCents}¢)`,
    );
    this.handled.push(event);
  }
}
