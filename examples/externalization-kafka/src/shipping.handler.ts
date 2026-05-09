import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { OrderPlacedEvent } from './order-placed.event';

/**
 * Local outbox listener. Runs on the same node as the publisher; the
 * `EventPublicationProcessor` invokes `handle()` inside a fresh
 * `REQUIRES_NEW` transaction (default `newTransaction: true`).
 *
 * Execution order per DD-019: local handlers run BEFORE
 * externalization. If `handle()` throws, the externalizer is NOT
 * called and the publication row stays `FAILED` for retry. If
 * `handle()` succeeds and the externalizer throws, the publication
 * row is also `FAILED` — single-unit atomicity covers BOTH the
 * in-process handler AND the broker delivery.
 *
 * Stable listener id (`Shipping.createShipment`) — renaming the
 * class would otherwise invalidate already-stored publication rows
 * keyed on `${ClassName}#${EventName}`.
 */
@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], id: 'Shipping.createShipment' })
export class ShippingHandler implements IOutboxEventHandler<OrderPlacedEvent> {
  private readonly logger = new Logger(ShippingHandler.name);

  readonly handled: OrderPlacedEvent[] = [];

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.logger.log(
      `Local handler: creating shipment for order ${event.orderId} (${event.customerEmail}, ${event.totalCents}¢)`,
    );
    this.handled.push(event);
  }
}
