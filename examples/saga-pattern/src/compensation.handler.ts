import { Injectable, Logger } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { OrderRow, StockItemRow } from './entities.js';
import type { InventoryReservationFailedEvent, PaymentFailedEvent } from './events.js';

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
 *   `'failed-payment'`. Both writes commit atomically.
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
export class CompensationHandler {
  private readonly logger = new Logger(CompensationHandler.name);

  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
    @InjectRepository(StockItemRow)
    private readonly stock: Repository<StockItemRow>,
  ) {}

  /**
   * Reservation failed before stock was decremented, so there is
   * nothing to restore. The reservation handler already wrote the
   * terminal status; this step only records that compensation ran.
   */
  @OnOutboxMessage('InventoryReservationFailedEvent', { consumer: 'saga.compensation' })
  onReservationFailed(event: InventoryReservationFailedEvent): void {
    this.logger.log(`Compensation: reservation-failed for ${event.orderId} (no stock to release)`);
  }

  /**
   * Payment failed after stock was reserved: restore the stock and mark
   * the order failed-payment. The conditional `WHERE status = 'reserved'`
   * is the idempotency gate: a retried delivery finds the order in
   * `'failed-payment'`, the UPDATE affects zero rows, and the stock is
   * not restored twice.
   */
  @OnOutboxMessage('PaymentFailedEvent', { consumer: 'saga.compensation' })
  @Transactional()
  async onPaymentFailed(event: PaymentFailedEvent): Promise<void> {
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

    this.logger.warn(
      `Compensation: released ${event.quantity} of ${event.sku} for ${event.orderId}`,
    );
  }
}
