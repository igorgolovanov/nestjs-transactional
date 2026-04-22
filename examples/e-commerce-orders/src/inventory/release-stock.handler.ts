import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { Repository } from 'typeorm';

import { PaymentFailedEvent } from '../shared/events';
import { ProductRow } from './product.entity';
import { ReservationRow } from './reservation.entity';

/**
 * Compensation step in the inventory context. On `PaymentFailedEvent`
 * (owned by billing DS), find every still-`'reserved'` row for this
 * order, restore its stock to `products.available`, and mark the
 * reservation row `'released'`.
 *
 * Idempotency: gated on `status = 'reserved'` in the conditional
 * UPDATE. A retried delivery finds the rows already `'released'`
 * and zero-affects.
 */
@Injectable()
@IntegrationEventsHandler({ events: [PaymentFailedEvent], id: 'Inventory.ReleaseStock' })
export class ReleaseStockHandler implements IIntegrationEventHandler<PaymentFailedEvent> {
  private readonly logger = new Logger(ReleaseStockHandler.name);

  constructor(
    @InjectRepository(ProductRow, 'inventory')
    private readonly products: Repository<ProductRow>,
    @InjectRepository(ReservationRow, 'inventory')
    private readonly reservations: Repository<ReservationRow>,
  ) {}

  async handle(event: PaymentFailedEvent): Promise<void> {
    // Inner-method indirection for the same reason as
    // `ChargePaymentHandler` — see its JSDoc.
    await this.processInInventoryTx(event);
  }

  @Transactional({ dataSource: 'inventory' })
  private async processInInventoryTx(event: PaymentFailedEvent): Promise<void> {
    const rows = await this.reservations.find({
      where: { orderId: event.orderId, status: 'reserved' },
    });

    if (rows.length === 0) {
      this.logger.log(`No reserved stock for ${event.orderId} — compensation no-op`);
      return;
    }

    for (const row of rows) {
      const update = await this.reservations.update(
        { id: row.id, status: 'reserved' },
        { status: 'released' },
      );
      if (update.affected === 0) {
        // Lost the race to another worker; skip to avoid double-restoring.
        continue;
      }
      await this.products
        .createQueryBuilder()
        .update(ProductRow)
        .set({ available: () => `"available" + ${row.quantity}` })
        .where('sku = :sku', { sku: row.sku })
        .execute();
    }

    this.logger.warn(`Released ${rows.length} reservations for ${event.orderId}`);
  }
}
