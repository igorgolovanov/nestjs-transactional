import { Injectable, Logger } from '@nestjs/common';
import {
  ApplicationModuleHandler,
  type IApplicationModuleHandler,
} from '@nestjs-transactional/cqrs';

import { OrderPlacedEvent } from './order.aggregate';

/**
 * Persistent cross-module handler. `@ApplicationModuleHandler` routes
 * to the outbox when the `OUTBOX_LISTENER_REGISTRAR` token is bound
 * (as wired by `OutboxModule` in this example). The worker picks up
 * the publication row after the publishing transaction has
 * committed, invokes `handle()` inside a fresh `REQUIRES_NEW`
 * transaction, and marks the publication `COMPLETED` on success.
 *
 * Without the outbox wired, the same decorator falls back to
 * in-memory AFTER_COMMIT delivery — identical source code, two
 * delivery modes selected by module wiring.
 */
@Injectable()
@ApplicationModuleHandler({ events: [OrderPlacedEvent], id: 'Shipping.createShipment' })
export class ShippingHandlers implements IApplicationModuleHandler<OrderPlacedEvent> {
  private readonly logger = new Logger(ShippingHandlers.name);

  handled: string[] = [];

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.logger.log(`Creating shipment for order ${event.orderId}`);
    this.handled.push(event.orderId);
    // Real code would call into a shipping provider API here. The
    // outbox's at-least-once delivery means that network or
    // downstream failures just land the publication in FAILED, from
    // where an operator can resubmit.
  }
}
