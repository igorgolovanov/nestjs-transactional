import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';

import { OrderPlacedEvent } from './order-placed.event';
import { OrderService } from './order.service';
import { ShippingHandler } from './shipping.handler';

/**
 * Foundational outbox example. Uses `InMemoryTransactionAdapter` (test
 * adapter from `@nestjs-transactional/core/testing`) and the default
 * `InMemoryEventPublicationRepository` so the example runs with no
 * database and no Docker.
 *
 * Both in-memory backends are transaction-aware: a transaction
 * rollback also undoes the publication-row append, which mirrors the
 * single-unit atomicity contract (DD-019) that a real persistence
 * backend (TypeORM, Prisma, ...) provides.
 */
@Module({
  imports: [
    TransactionalModule.forRoot({
      adapter: new InMemoryTransactionAdapter(),
      isGlobal: true,
      registerInterceptor: false,
    }),

    OutboxModule.forRoot({
      // Faster than the default (500 ms) so the example demo and tests
      // observe delivery without a perceptible wait. Production tunes
      // the polling interval to the durability/latency trade-off.
      processor: { pollingInterval: 50, batchSize: 50 },
    }),
    OutboxModule.forFeature([OrderPlacedEvent]),

    // Auto-starts the per-DS `EventPublicationProcessor` and
    // `StalenessMonitor`. In a real deployment this lives in a
    // dedicated worker process; the example runs it in-process so the
    // demo and the tests see end-to-end delivery.
    OutboxProcessingModule,
  ],
  providers: [OrderService, ShippingHandler],
})
export class AppModule {}
