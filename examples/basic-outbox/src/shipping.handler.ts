import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { OrderPlacedEvent } from './order-placed.event';

/**
 * Persistent outbox handler. The `EventPublicationProcessor` worker
 * polls the repository for pending publications, deserializes each
 * event via the registry, and invokes `handle()` inside a fresh
 * `REQUIRES_NEW` transaction (default `newTransaction: true`).
 *
 * On success the publication row is marked `COMPLETED`; on a thrown
 * exception the row stays `FAILED` until an operator resubmits or the
 * staleness monitor recycles it.
 */
@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], id: 'Shipping.createShipment' })
export class ShippingHandler implements IOutboxEventHandler<OrderPlacedEvent> {
  private readonly logger = new Logger(ShippingHandler.name);

  readonly handled: OrderPlacedEvent[] = [];

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.logger.log(`Creating shipment for order ${event.orderId} (${event.customerEmail})`);
    this.handled.push(event);
  }
}
