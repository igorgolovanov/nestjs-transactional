import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { CqrsTransactionalModule } from '@nestjs-transactional/cqrs';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { BillingNotificationListener } from './billing.listener';
import { InventoryNotificationListener } from './inventory.listener';
import { InvoiceRow, ReservationRow } from './entities';
import { IssueInvoiceHandler } from './issue-invoice.handler';
import { PlaceReservationHandler } from './place-reservation.handler';

/**
 * Multi-DS CQRS demo. Two SQLite in-memory DataSources via `sql.js`,
 * each backing one bounded context (billing / inventory). Phase 14.3.1
 * Category B is the headline feature: the cqrs in-memory dispatcher
 * attaches AFTER_COMMIT hooks to the *correct* dataSource's active
 * transaction by reading the listener's `dataSource` decorator option.
 *
 * Important: do NOT import `@nestjs/cqrs`'s `CqrsModule` directly.
 * `CqrsTransactionalModule` imports it internally and overrides the
 * `EventPublisher` DI token; a duplicate import shadows the override
 * and aggregate events bypass the dispatcher (CLAUDE.md convention #6).
 */
@Module({
  imports: [
    // Default DataSource — billing.
    TypeOrmModule.forRoot({
      type: 'sqljs',
      synchronize: true,
      entities: [InvoiceRow],
    }),
    TypeOrmModule.forFeature([InvoiceRow]),

    // Named DataSource — inventory.
    TypeOrmModule.forRoot({
      name: 'inventory',
      type: 'sqljs',
      synchronize: true,
      entities: [ReservationRow],
    }),
    TypeOrmModule.forFeature([ReservationRow], 'inventory'),

    // Process-wide infrastructure.
    TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),

    // One adapter per DataSource (ADR-018 multi-`forRoot`).
    TypeOrmTransactionalModule.forRoot({ isDefault: true }),
    TypeOrmTransactionalModule.forRoot({ dataSource: 'inventory' }),

    // Single CqrsTransactionalModule call — it covers all dataSources.
    // The dispatcher inspects each listener's `dataSource` option at
    // bootstrap and routes hooks accordingly.
    CqrsTransactionalModule.forRoot(),
  ],
  providers: [
    IssueInvoiceHandler,
    PlaceReservationHandler,
    BillingNotificationListener,
    InventoryNotificationListener,
  ],
})
export class AppModule {}
