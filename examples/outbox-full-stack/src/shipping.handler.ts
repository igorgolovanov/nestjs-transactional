import { Injectable, Logger } from '@nestjs/common';
import { ApplicationModuleListener } from '@nestjs-transactional/cqrs';

import { OrderPlacedEvent } from './order.aggregate';

/**
 * Persistent cross-module listener. `@ApplicationModuleListener` maps
 * to `@OutboxEventListener(..., { newTransaction: true })` when the
 * outbox is wired (as it is in this example). The worker picks up
 * the publication row after the publishing transaction has
 * committed, invokes this method inside a fresh `REQUIRES_NEW`
 * transaction, and marks the publication `COMPLETED` on success.
 */
@Injectable()
export class ShippingHandlers {
  private readonly logger = new Logger(ShippingHandlers.name);

  handled: string[] = [];

  @ApplicationModuleListener(OrderPlacedEvent, { id: 'Shipping.createShipment' })
  async createShipment(event: OrderPlacedEvent): Promise<void> {
    this.logger.log(`Creating shipment for order ${event.orderId}`);
    this.handled.push(event.orderId);
    // Real code would call into a shipping provider API here. The
    // outbox's at-least-once delivery means that network or
    // downstream failures just land the publication in FAILED, from
    // where an operator can resubmit.
  }
}
