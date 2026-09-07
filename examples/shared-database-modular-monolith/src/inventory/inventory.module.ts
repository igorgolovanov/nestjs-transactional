import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@nestjs-transactional/outbox';

import { InventoryShipmentProjectionListener } from './inventory.listener.js';
import { InventoryService } from './inventory.service.js';
import { ReservationPlacedEvent } from './reservation-placed.event.js';
import { ReservationRow } from './reservation.entity.js';

/**
 * `InventoryModule` mirrors `BillingModule` — entity feature, event
 * registration, service, listener — for the inventory bounded
 * context. Per-DS outbox infrastructure (`forRoot`) lives in
 * `AppModule` (see `BillingModule` JSDoc for the init-order
 * rationale).
 *
 * The inventory module is bound to the named `'inventory'`
 * DataSource; physically it lives in the Postgres `inventory`
 * schema. Both schemas share the same physical Postgres database —
 * DD-023 cross-DS isolation extends to schema-level separation.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ReservationRow], 'inventory'),
    OutboxModule.forFeature([ReservationPlacedEvent], { dataSource: 'inventory' }),
  ],
  providers: [InventoryService, InventoryShipmentProjectionListener],
  exports: [InventoryService],
})
export class InventoryModule {}
