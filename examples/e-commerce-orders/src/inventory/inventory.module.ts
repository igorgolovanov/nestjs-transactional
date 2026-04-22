import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@nestjs-transactional/outbox';

import {
  StockReservationFailedEvent,
  StockReservedEvent,
} from '../shared/events';
import { ProductRow } from './product.entity';
import { ReleaseStockHandler } from './release-stock.handler';
import { ReservationRow } from './reservation.entity';
import { ReserveStockHandler } from './reserve-stock.handler';

/**
 * Inventory bounded context. Owns the inventory DataSource entities
 * and the events the inventory context publishes.
 *
 * Note `forFeature` second-arg `'inventory'`: TypeORM resolves
 * `ProductRow` and `ReservationRow` against the inventory DS, NOT
 * the default (orders) one. The handlers' `@InjectRepository(...,
 * 'inventory')` matches.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ProductRow, ReservationRow], 'inventory'),
    OutboxModule.forFeature([StockReservedEvent, StockReservationFailedEvent], {
      dataSource: 'inventory',
    }),
  ],
  providers: [ReserveStockHandler, ReleaseStockHandler],
})
export class InventoryModule {}
