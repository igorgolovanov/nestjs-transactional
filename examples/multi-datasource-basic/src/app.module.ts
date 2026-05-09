import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { BillingService } from './billing.service';
import { InventoryService } from './inventory.service';
import { InvoiceEntity, StockItemEntity } from './entities';

/**
 * Multi-DataSource example using two SQLite in-memory databases via
 * `sql.js`. No Docker, no external setup. The two DataSources are
 * fully independent — neither knows about the other's tables —
 * demonstrating Spring-style cross-DS isolation (DD-023): a
 * transaction on dataSource A does NOT silently enrol dataSource B.
 *
 * Wiring follows ADR-018 multi-`forRoot` pattern: one
 * `TypeOrmTransactionalModule.forRoot` per dataSource, plus the
 * standard `@nestjs/typeorm` `TypeOrmModule.forRoot/forFeature`
 * registrations under the matching dataSource name.
 */
@Module({
  imports: [
    // Default DataSource — `billing`. Registered without an explicit
    // name so `@nestjs/typeorm`'s default-name conventions apply,
    // and `@InjectRepository(InvoiceEntity)` resolves Repositories
    // bound here.
    TypeOrmModule.forRoot({
      type: 'sqljs',
      synchronize: true,
      entities: [InvoiceEntity],
    }),
    TypeOrmModule.forFeature([InvoiceEntity]),

    // Named DataSource — `inventory`. Distinct connection,
    // independent schema. Repositories injected via
    // `@InjectRepository(StockItemEntity, 'inventory')`.
    TypeOrmModule.forRoot({
      name: 'inventory',
      type: 'sqljs',
      synchronize: true,
      entities: [StockItemEntity],
    }),
    TypeOrmModule.forFeature([StockItemEntity], 'inventory'),

    // Process-wide infrastructure — registered once.
    TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),

    // One TypeOrmTransactionalModule.forRoot per DataSource (ADR-018).
    // The first call (default) marks itself with `isDefault: true`;
    // the second registers under its named identifier. Importing
    // either module also activates the Phase 14.20 transparent-repository
    // patches at module-load time.
    TypeOrmTransactionalModule.forRoot({ isDefault: true }),
    TypeOrmTransactionalModule.forRoot({ dataSource: 'inventory' }),
  ],
  providers: [BillingService, InventoryService],
})
export class AppModule {}
