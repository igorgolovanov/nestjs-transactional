import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { StockAdjustedEvent } from './events';

/**
 * Phase 14.3.1 Category A auto-routing — same as
 * `BillingProjectionsHandler`. The scanner finds `StockAdjustedEvent`
 * registered to the inventory DS via
 * `OutboxModule.forFeature([StockAdjustedEvent], { dataSource: 'inventory' })`
 * and routes this handler to the inventory `OutboxListenerRegistry`.
 *
 * Worker for the inventory DS polls the inventory-DB
 * `event_publication` table independently of the billing one.
 */
@Injectable()
@OutboxEventsHandler({ events: [StockAdjustedEvent], id: 'InventoryProjections.stockAdjusted' })
export class InventoryProjectionsHandler implements IOutboxEventHandler<StockAdjustedEvent> {
  private readonly logger = new Logger(InventoryProjectionsHandler.name);

  readonly handled: StockAdjustedEvent[] = [];

  async handle(event: StockAdjustedEvent): Promise<void> {
    this.logger.log(`Inventory projection — sku ${event.sku} new quantity ${event.newQuantity}`);
    this.handled.push(event);
  }
}
