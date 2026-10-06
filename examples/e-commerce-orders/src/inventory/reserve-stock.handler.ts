import { Injectable, Logger } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { QueryFailedError, Repository } from 'typeorm';

import {
  OrderPlacedEvent,
  StockReservationFailedEvent,
  StockReservedEvent,
} from '../shared/events.js';

import { ProductRow } from './product.entity.js';
import { ReservationRow } from './reservation.entity.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

class OutOfStockError extends Error {
  constructor(
    message: string,
    readonly reservedSkus: string[],
  ) {
    super(message);
  }
}

/**
 * Inventory step. Subscribes to `orders.placed`, the topic
 * `OrderPlacedEvent` is `@Externalized` to, and works on the tables in
 * the `inventory` schema.
 *
 * For each line item:
 *   1. Try a conditional `UPDATE products SET available = available - qty
 *      WHERE sku = :sku AND available >= :qty`. Zero rows = OOS.
 *   2. On success, INSERT a `ReservationRow` keyed on
 *      `${orderId}:${sku}`. `unique_violation` = retry; idempotent
 *      skip.
 *
 * If ANY line item fails, the reserve transaction rolls back —
 * partial reservations from earlier lines disappear. The
 * handler catches the OOS marker outside the @Transactional and
 * publishes `StockReservationFailedEvent` from a **fresh**
 * transaction so the failure is recorded durably.
 *
 * On all-success: emit `StockReservedEvent` atomically with the
 * reservation rows.
 */
@Injectable()
export class ReserveStockHandler {
  private readonly logger = new Logger(ReserveStockHandler.name);

  constructor(
    @InjectRepository(ProductRow)
    private readonly products: Repository<ProductRow>,
    @InjectRepository(ReservationRow)
    private readonly reservations: Repository<ReservationRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @OnOutboxMessage('orders.placed', { consumer: 'inventory.reserve-stock' })
  async handle(event: OrderPlacedEvent): Promise<void> {
    try {
      await this.tryReserve(event);
      this.logger.log(`Reserved stock for ${event.orderId}`);
    } catch (err) {
      if (!(err instanceof OutOfStockError)) {
        throw err;
      }
      await this.publishFailure(event, err.message);
    }
  }

  /**
   * The actual reservation transaction. Throws `OutOfStockError`
   * on first OOS line — rolls back every prior decrement / insert
   * in this call. The caller catches it.
   */
  @Transactional()
  private async tryReserve(event: OrderPlacedEvent): Promise<void> {
    const reservedSkus: string[] = [];

    for (const item of event.items) {
      const decrement = await this.products
        .createQueryBuilder()
        .update(ProductRow)
        .set({ available: () => `"available" - ${item.quantity}` })
        .where('sku = :sku AND available >= :qty', {
          sku: item.sku,
          qty: item.quantity,
        })
        .execute();

      if (decrement.affected === 0) {
        throw new OutOfStockError(`out of stock: ${item.sku}`, reservedSkus);
      }

      try {
        await this.reservations.insert({
          id: `${event.orderId}:${item.sku}`,
          orderId: event.orderId,
          sku: item.sku,
          quantity: item.quantity,
          status: 'reserved',
        });
      } catch (err) {
        if (
          err instanceof QueryFailedError &&
          (err.driverError as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION
        ) {
          // Already reserved on a prior delivery — undo the
          // just-decremented stock and skip this line. This branch
          // ALSO triggers when retry hits a previously-OOS line
          // already inserted; benign.
          await this.products
            .createQueryBuilder()
            .update(ProductRow)
            .set({ available: () => `"available" + ${item.quantity}` })
            .where('sku = :sku', { sku: item.sku })
            .execute();
          continue;
        }
        throw err;
      }
      reservedSkus.push(item.sku);
    }

    await this.outbox.publish(
      new StockReservedEvent(event.orderId, event.customerId, event.totalAmountCents),
    );
  }

  @Transactional()
  private async publishFailure(event: OrderPlacedEvent, reason: string): Promise<void> {
    await this.outbox.publish(new StockReservationFailedEvent(event.orderId, reason, []));
  }
}
