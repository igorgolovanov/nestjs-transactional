import { Injectable, Logger } from '@nestjs/common';
import {
  type ITransactionalEventHandler,
  TransactionalEventsHandler,
} from '@nestjs-transactional/cqrs';

import { ReservationPlacedEvent } from './reservation.aggregate';

/**
 * Phase 14.3.1 Category B in action. The `dataSource: 'inventory'`
 * option tells `TransactionalEventDispatcher.scheduleDispatch` to
 * resolve the active transaction via
 * `TransactionContext.getActiveTransactionByDataSource('inventory')`
 * — bypassing `TransactionManager.registerBeforeCommit`'s
 * first-active-tx semantics. Without this option the dispatcher would
 * attach to whatever transaction is "first active" in the context,
 * which breaks down the moment two dataSources are concurrently in
 * play.
 */
@Injectable()
@TransactionalEventsHandler({
  events: [ReservationPlacedEvent],
  dataSource: 'inventory',
})
export class InventoryNotificationListener
  implements ITransactionalEventHandler<ReservationPlacedEvent>
{
  private readonly logger = new Logger(InventoryNotificationListener.name);

  readonly notified: string[] = [];

  handle(event: ReservationPlacedEvent): void {
    this.notified.push(event.reservationId);
    this.logger.log(
      `AFTER_COMMIT (inventory) — notifying for reservation ${event.reservationId}`,
    );
  }
}
