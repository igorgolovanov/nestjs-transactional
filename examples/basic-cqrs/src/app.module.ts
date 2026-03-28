import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';
import { CqrsTransactionalModule } from '@nestjs-transactional/cqrs';

import { GetNotifiedOrdersHandler } from './get-notified-orders.query';
import { NotificationHandler } from './notification.handler';
import { PlaceOrderHandler } from './place-order.handler';

/**
 * Foundational CQRS example. Uses `InMemoryTransactionAdapter` so the
 * example runs without a database — the focus is the event-dispatch
 * lifecycle, not persistence.
 *
 * Important: do NOT import `@nestjs/cqrs`'s `CqrsModule` directly.
 * `CqrsTransactionalModule` imports it internally and overrides the
 * `EventPublisher` DI token; a duplicate import shadows the override
 * and aggregate events bypass the dispatcher (CLAUDE.md convention #6).
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
