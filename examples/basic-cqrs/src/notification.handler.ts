import { Injectable, Logger } from '@nestjs/common';
import {
  type ITransactionalEventHandler,
  TransactionalEventsHandler,
} from '@nestjs-transactional/cqrs';

import { OrderPlacedEvent } from './order.aggregate';

/**
 * In-memory phase-aware listener. Default phase is `AFTER_COMMIT` —
 * the canonical use case: only react once the surrounding transaction
 * has actually committed. If the publishing transaction rolls back,
 * this handler is NEVER invoked.
 *
 * Distinct from `@OutboxEventsHandler` (durable, retried, persistent)
 * and `@IntegrationEventsHandler` (smart default that switches between
 * the two based on module wiring) — see `basic-outbox` for the
 * persistent variant.
 */
@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
export class NotificationHandler implements ITransactionalEventHandler<OrderPlacedEvent> {
  private readonly logger = new Logger(NotificationHandler.name);

  readonly notified: string[] = [];

  handle(event: OrderPlacedEvent): void {
    this.notified.push(event.orderId);
    this.logger.log(`AFTER_COMMIT — notifying customer for order ${event.orderId}`);
  }
}
