import { Injectable, Logger } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';

import type { OrderPlacedEvent } from './order-placed.event.js';

/**
 * Durable in-process handler. `OrderPlacedEvent` has no `@Externalized`,
 * so the bridge adds it under its class name, and `@nestjs/outbox`'s
 * relay delivers it here after the publishing transaction commits.
 *
 * A thrown error is retried with backoff and, once the attempts run out,
 * dead-lettered. The `consumer` name keys this handler's inbox, so a
 * redelivered message is not handled twice; keep it stable.
 *
 * The payload is plain JSON, not an `OrderPlacedEvent` instance: the
 * outbox serialises it when the message is added.
 */
@Injectable()
export class ShippingHandler {
  private readonly logger = new Logger(ShippingHandler.name);

  readonly handled: OrderPlacedEvent[] = [];

  @OnOutboxMessage('OrderPlacedEvent', { consumer: 'shipping.create-shipment' })
  async createShipment(event: OrderPlacedEvent): Promise<void> {
    this.logger.log(
      `Creating shipment for order ${event.orderId} (${event.customerEmail}, ${event.totalCents}¢)`,
    );
    this.handled.push(event);
  }
}
