import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { Repository } from 'typeorm';

import { OrderRow, StockItemRow } from './entities';
import { InventoryReservationFailedEvent, PaymentFailedEvent } from './events';

/**
 * Compensation step. Subscribes to **both** failure events and runs
 * the appropriate undo:
 *
 * - `InventoryReservationFailedEvent` — nothing to undo materially
 *   (no stock was decremented, no payment was attempted); just mark
 *   the order terminal-failed. The reservation handler already
 *   wrote `'failed-reservation'` atomically with the failure event,
 *   so this branch is mostly observability/logging.
 * - `PaymentFailedEvent` — the reservation handler did decrement
 *   stock, so we restore it AND mark the order
 *   `'failed-payment'`. Both writes commit atomically (DD-019).
 *
 * Compensation here is choreographic: just another step that
 * happens to run because a failure event was published. There is no
 * "saga orchestrator" class — the framework treats compensation
 * handlers like any other outbox handler. See the README's
 * `Choreography vs orchestration` section for when an orchestrator
 * pays its own complexity.
 *
 * Idempotency: each branch's "have we already compensated?" check
 * is encoded as a conditional UPDATE — see the per-branch comments.
 */
@Injectable()
@IntegrationEventsHandler({
  events: [InventoryReservationFailedEvent, PaymentFailedEvent],
  id: 'Saga.Compensation',
})
export class CompensationHandler
  implements IIntegrationEventHandler<InventoryReservationFailedEvent | PaymentFailedEvent>
{
  private readonly logger = new Logger(CompensationHandler.name);

  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
    @InjectRepository(StockItemRow)
    private readonly stock: Repository<StockItemRow>,
  ) {}

  @Transactional()
  async handle(event: InventoryReservationFailedEvent | PaymentFailedEvent): Promise<void> {
    if (event instanceof InventoryReservationFailedEvent) {
      // Reservation failed before stock was decremented — nothing to
      // restore. Confirm the terminal status (the reservation handler
      // wrote it; if it's already there we still want this branch to
      // be a no-op, not an error).
      this.logger.log(`Compensation: reservation-failed for ${event.orderId} (no stock to release)`);
      return;
    }

    // PaymentFailedEvent — restore the reserved stock and mark the
    // order failed-payment. The conditional `WHERE status = 'reserved'`
    // is the idempotency gate: a retried delivery finds the order in
    // `'failed-payment'` and the UPDATE affects zero rows, so the
    // stock-restoration branch is gated by the same predicate via
    // the inner `if`.
    const update = await this.orders.update(
      { id: event.orderId, status: 'reserved' },
      { status: 'failed-payment' },
    );

    if (update.affected === 0) {
      this.logger.log(`Compensation: ${event.orderId} not in 'reserved' — idempotent skip`);
      return;
    }

    await this.stock
      .createQueryBuilder()
      .update(StockItemRow)
      .set({ available: () => `"available" + ${event.quantity}` })
      .where('sku = :sku', { sku: event.sku })
      .execute();

    this.logger.warn(`Compensation: released ${event.quantity} of ${event.sku} for ${event.orderId}`);
  }
}
