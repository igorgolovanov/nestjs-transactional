import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { OrderPlacedEvent } from './order-placed.event';

/**
 * Persistent outbox handler. After the publishing transaction commits
 * the worker (`EventPublicationProcessor`) polls Postgres with
 * `FOR UPDATE SKIP LOCKED`, deserializes the event, and invokes
 * `handle()` inside a fresh `REQUIRES_NEW` transaction (default
 * `newTransaction: true`). On success the row is marked `COMPLETED`;
 * a thrown exception leaves the row `FAILED` for an operator to
 * resubmit.
 */
@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], id: 'Shipping.createShipment' })
export class ShippingHandler implements IOutboxEventHandler<OrderPlacedEvent> {
  private readonly logger = new Logger(ShippingHandler.name);

  readonly handled: OrderPlacedEvent[] = [];

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.logger.log(
      `Creating shipment for order ${event.orderId} (${event.customerEmail}, ${event.totalCents}¢)`,
    );
    this.handled.push(event);
  }
}
