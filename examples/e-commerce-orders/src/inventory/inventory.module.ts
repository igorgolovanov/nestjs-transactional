import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductRow } from './product.entity.js';
import { ReleaseStockHandler } from './release-stock.handler.js';
import { ReservationRow } from './reservation.entity.js';
import { ReserveStockHandler } from './reserve-stock.handler.js';

/**
 * Inventory bounded context. Owns the tables in the `inventory` schema
 * and the events the inventory context publishes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProductRow, ReservationRow])],
  providers: [ReserveStockHandler, ReleaseStockHandler],
})
export class InventoryModule {}
