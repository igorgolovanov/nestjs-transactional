import { Injectable, Logger } from '@nestjs/common';
import {
  type ITransactionalEventHandler,
  TransactionPhase,
  TransactionalEventsHandler,
} from '@nestjs-transactional/cqrs';

import { OrderPlacedEvent } from './order.aggregate';

/**
 * AFTER_COMMIT handler — the canonical "event is now durable, publish
 * side-effects" class. Fires only once the surrounding transaction
 * has actually committed.
 */
@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
export class OrderCommittedProjection
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  private readonly logger = new Logger(OrderCommittedProjection.name);

  committed: string[] = [];

  handle(event: OrderPlacedEvent): void {
    this.committed.push(event.orderId);
    this.logger.log(`AFTER_COMMIT — order ${event.orderId} is durable, projecting...`);
  }
}

/**
 * AFTER_ROLLBACK handler — observes the rolled-back emission.
 * Distinct class because the new class-level API binds one
 * `@TransactionalEventsHandler` per class (single responsibility).
 */
@Injectable()
@TransactionalEventsHandler({
  events: [OrderPlacedEvent],
  phase: TransactionPhase.AFTER_ROLLBACK,
})
export class OrderRollbackProjection
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  private readonly logger = new Logger(OrderRollbackProjection.name);

  rolledBack: string[] = [];

  handle(event: OrderPlacedEvent, error?: unknown): void {
    this.rolledBack.push(event.orderId);
    this.logger.warn(
      `AFTER_ROLLBACK — order ${event.orderId} NOT persisted; cause: ${(error as Error).message}`,
    );
  }
}
