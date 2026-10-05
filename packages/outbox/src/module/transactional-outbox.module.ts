import { type DynamicModule, Module } from '@nestjs/common';

import {
  OutboxEventPublisher,
  type TransactionalOutboxOptions,
} from '../publisher/outbox-event-publisher.js';

import { OUTBOX_PUBLICATION_SCHEDULER, TRANSACTIONAL_OUTBOX_OPTIONS } from './tokens.js';

/**
 * Binds {@link OutboxEventPublisher} to `@nestjs/outbox`, and to the cqrs
 * `HybridEventPublisher` so `AggregateRoot.commit()` reaches the outbox.
 *
 * `OutboxModule` and its store are configured as `@nestjs/outbox`
 * documents them; this module adds only the transactional side.
 */
@Module({})
export class TransactionalOutboxModule {
  static forRoot(options: TransactionalOutboxOptions = {}): DynamicModule {
    return {
      module: TransactionalOutboxModule,
      global: true,
      providers: [
        { provide: TRANSACTIONAL_OUTBOX_OPTIONS, useValue: options },
        OutboxEventPublisher,
        { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
      ],
      exports: [OutboxEventPublisher, OUTBOX_PUBLICATION_SCHEDULER],
    };
  }
}
