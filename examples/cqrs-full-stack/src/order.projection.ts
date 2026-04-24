import { Injectable, Logger } from '@nestjs/common';
import {
  TransactionPhase,
  TransactionalEventsListener,
} from '@nestjs-transactional/cqrs';

import { OrderPlacedEvent } from './order.aggregate';

@Injectable()
export class OrderProjection {
  private readonly logger = new Logger(OrderProjection.name);

  committed: string[] = [];
  rolledBack: string[] = [];

  @TransactionalEventsListener(OrderPlacedEvent)
  onCommitted(event: OrderPlacedEvent): void {
    this.committed.push(event.orderId);
    this.logger.log(`AFTER_COMMIT — order ${event.orderId} is durable, projecting...`);
  }

  @TransactionalEventsListener(OrderPlacedEvent, { phase: TransactionPhase.AFTER_ROLLBACK })
  onRolledBack(event: OrderPlacedEvent, error: unknown): void {
    this.rolledBack.push(event.orderId);
    this.logger.warn(
      `AFTER_ROLLBACK — order ${event.orderId} NOT persisted; cause: ${(error as Error).message}`,
    );
  }
}
