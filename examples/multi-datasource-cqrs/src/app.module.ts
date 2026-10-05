import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalCqrsModule } from '@nestjs-transactional/cqrs';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';

import { BillingNotificationListener } from './billing.listener.js';
import { InvoiceRow, ReservationRow } from './entities.js';
import { InventoryNotificationListener } from './inventory.listener.js';
import { IssueInvoiceHandler } from './issue-invoice.handler.js';
import { PlaceReservationHandler } from './place-reservation.handler.js';

/**
 * Multi-DS CQRS demo. Two SQLite in-memory DataSources via `sql.js`,
 * each backing one bounded context (billing / inventory).
 * Category B is the headline feature: the cqrs in-memory dispatcher
 * attaches AFTER_COMMIT hooks to the *correct* dataSource's active
 * transaction by reading the listener's `dataSource` decorator option.
 *
 * Important: do NOT import `@nestjs/cqrs`'s `CqrsModule` directly.
 * `TransactionalCqrsModule` imports `CqrsModule.forRoot()` itself, with
 * its publisher in the `EventBus`; a second import creates a second
 * `EventBus` and bootstrap fails (`docs/status/conventions.md` #6).
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
    TransactionalTypeOrmModule.forRoot({ isDefault: true }),
    TransactionalTypeOrmModule.forRoot({ dataSource: 'inventory' }),

    // Single TransactionalCqrsModule call — it covers all dataSources.
    // The dispatcher inspects each listener's `dataSource` option at
    // bootstrap and routes hooks accordingly.
    TransactionalCqrsModule.forRoot(),
  ],
  providers: [
    IssueInvoiceHandler,
    PlaceReservationHandler,
    BillingNotificationListener,
    InventoryNotificationListener,
  ],
})
export class AppModule {}
