import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { QueryFailedError, Repository } from 'typeorm';

import { OrderRow, ReservationRow, StockItemRow } from './entities';
import {
  InventoryReservationFailedEvent,
  InventoryReservedEvent,
  OrderPlacedEvent,
} from './events';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Saga step 1. Subscribes to `OrderPlacedEvent` from the outbox.
 *
 * Inside a fresh `@Transactional()`:
 *   1. Insert the `ReservationRow` first. `orderId` is the primary
 *      key — a `unique_violation` here means we have already run for
 *      this order (outbox at-least-once retry); we skip the rest of
 *      the step idempotently.
 *   2. Decrement stock with a conditional `UPDATE` that asserts
 *      `available >= quantity`. Zero rows updated = out of stock.
 *   3. Update the order to `'reserved'` (intermediate status — the
 *      compensation handler reads it).
 *   4. Publish `InventoryReservedEvent` (success) or
 *      `InventoryReservationFailedEvent` (out of stock) atomically
 *      with the writes above.
 *
 * Because `(2) → (4)` all live in one transaction, any failure rolls
 * the whole step back; the outbox worker requeues the publication
 * and retries.
 */
@Injectable()
@IntegrationEventsHandler({ events: [OrderPlacedEvent], id: 'Saga.Reservation' })
export class ReservationHandler implements IIntegrationEventHandler<OrderPlacedEvent> {
  private readonly logger = new Logger(ReservationHandler.name);

  constructor(
    @InjectRepository(ReservationRow)
    private readonly reservations: Repository<ReservationRow>,
    @InjectRepository(StockItemRow)
    private readonly stock: Repository<StockItemRow>,
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async handle(event: OrderPlacedEvent): Promise<void> {
    try {
      await this.reservations.insert({
        orderId: event.orderId,
        sku: event.sku,
        quantity: event.quantity,
      });
    } catch (err) {
      if (err instanceof QueryFailedError && (err.driverError as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
        this.logger.log(`Reservation for ${event.orderId} already exists — idempotent skip`);
        return;
      }
      throw err;
    }

    const decrement = await this.stock
      .createQueryBuilder()
      .update(StockItemRow)
      .set({ available: () => `"available" - ${event.quantity}` })
      .where('sku = :sku AND available >= :qty', { sku: event.sku, qty: event.quantity })
      .execute();

    if (decrement.affected === 0) {
      this.logger.warn(`Out of stock for ${event.sku} — emitting failure`);
      await this.orders.update(event.orderId, { status: 'failed-reservation' });
      await this.outbox.publish(
        new InventoryReservationFailedEvent(event.orderId, event.sku, 'out-of-stock'),
      );
      return;
    }

    await this.orders.update(event.orderId, { status: 'reserved' });
    await this.outbox.publish(
      new InventoryReservedEvent(event.orderId, event.sku, event.quantity, event.amount),
    );
  }
}
