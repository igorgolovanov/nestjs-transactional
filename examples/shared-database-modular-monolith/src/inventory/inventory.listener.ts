import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { ReservationPlacedEvent } from './reservation-placed.event';

@Injectable()
@OutboxEventsHandler({
  events: [ReservationPlacedEvent],
  id: 'inventory.shipment-projection',
})
export class InventoryShipmentProjectionListener
  implements IOutboxEventHandler<ReservationPlacedEvent>
{
  private readonly logger = new Logger(InventoryShipmentProjectionListener.name);

  readonly observed: ReservationPlacedEvent[] = [];

  async handle(event: ReservationPlacedEvent): Promise<void> {
    this.logger.log(
      `inventory.shipment-projection — reservation ${event.reservationId} (${event.sku} × ${event.quantity})`,
    );
    this.observed.push(event);
  }
}
