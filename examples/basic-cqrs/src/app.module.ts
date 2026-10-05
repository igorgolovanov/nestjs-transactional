import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';
import { CqrsTransactionalModule } from '@nestjs-transactional/cqrs';

import { GetNotifiedOrdersHandler } from './get-notified-orders.query.js';
import { NotificationHandler } from './notification.handler.js';
import { PlaceOrderHandler } from './place-order.handler.js';

/**
 * Foundational CQRS example. Uses `InMemoryTransactionAdapter` so the
 * example runs without a database — the focus is the event-dispatch
 * lifecycle, not persistence.
 *
 * Important: do NOT import `@nestjs/cqrs`'s `CqrsModule` directly.
 * `CqrsTransactionalModule` imports `CqrsModule.forRoot()` itself, with
 * its publisher in the `EventBus`; a second import creates a second
 * `EventBus` and bootstrap fails (`docs/status/conventions.md` #6).
 */
@Module({
  imports: [
    TransactionalModule.forRoot({
      adapter: new InMemoryTransactionAdapter(),
      isGlobal: true,
      registerInterceptor: false,
    }),
    CqrsTransactionalModule.forRoot(),
  ],
  providers: [PlaceOrderHandler, GetNotifiedOrdersHandler, NotificationHandler],
})
export class AppModule {}
