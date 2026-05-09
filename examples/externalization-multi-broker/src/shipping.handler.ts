import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { OrderPlacedEvent } from './order-placed.event';

/**
 * Local listener for `OrderPlacedEvent`. Runs BEFORE the externalizer
 * dispatches to Kafka (DD-019 ordering). If `handle()` throws, Kafka
 * is NEVER emitted and the publication is marked `FAILED`.
 *
 * Every event class in this example has its own local handler — the
 * pattern is uniform regardless of which broker the event is routed
 * to.
 */
@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], id: 'Shipping.createShipment' })
export class ShippingHandler implements IOutboxEventHandler<OrderPlacedEvent> {
  private readonly logger = new Logger(ShippingHandler.name);

  readonly handled: OrderPlacedEvent[] = [];

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.logger.log(`Local: shipping for order ${event.orderId}`);
    this.handled.push(event);
  }
}
