import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { ReservationPlacedEvent } from './events';

/**
 * Local listener for the inventory DS. `ReservationPlacedEvent` is
 * registered via `OutboxModule.forFeature([...], { dataSource:
 * 'inventory' })`; the scanner auto-binds this handler to the
 * inventory DS's `OutboxListenerRegistry`. Runs BEFORE the
 * externalization to INVENTORY_BROKER.
 */
@Injectable()
@OutboxEventsHandler({ events: [ReservationPlacedEvent], id: 'Inventory.allocateStock' })
export class InventoryAllocationHandler
  implements IOutboxEventHandler<ReservationPlacedEvent>
{
  private readonly logger = new Logger(InventoryAllocationHandler.name);

  readonly handled: ReservationPlacedEvent[] = [];

  async handle(event: ReservationPlacedEvent): Promise<void> {
    this.logger.log(
      `Inventory local: allocating stock for reservation ${event.reservationId} (${event.sku} x${event.quantity})`,
    );
    this.handled.push(event);
  }
}
