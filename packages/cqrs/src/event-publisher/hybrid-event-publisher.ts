import { Inject, Injectable, Optional } from '@nestjs/common';
import type { IEvent, IEventPublisher } from '@nestjs/cqrs';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher.js';

/**
 * Minimal structural contract for the outbox side of
 * {@link HybridEventPublisher}. Declared here rather than imported from
 * `@nestjs-transactional/outbox`, so cqrs works without the outbox.
 *
 * `@nestjs-transactional/outbox`'s `OutboxEventPublisher` implements it,
 * and `TransactionalOutboxModule.forRoot()` binds it to
 * {@link OUTBOX_PUBLICATION_SCHEDULER} by itself.
 */
export interface OutboxPublicationScheduler {
  scheduleForPublication(event: unknown): void;
}

/**
 * DI token for the optional outbox scheduler injected into
 * {@link HybridEventPublisher}. When unbound, the hybrid publisher
 * delegates only to the in-memory dispatcher.
 *
 * A `Symbol.for` key: `@nestjs-transactional/outbox` binds the same key
 * without depending on this package.
 */
export const OUTBOX_PUBLICATION_SCHEDULER = Symbol.for(
  '@nestjs-transactional/cqrs/outbox-publication-scheduler',
);

/**
 * `IEventPublisher` implementation that routes aggregate-emitted
 * events through the in-memory transactional dispatcher
 * (`@TransactionalEventsHandler`) and, when wired, the outbox. Both
 * paths run inside the surrounding transaction:
 *
 * - In-memory: the dispatcher attaches hooks to the current
 *   transaction so listeners fire at the configured phase
 *   (`AFTER_COMMIT` by default). No database rows are written.
 * - Outbox: {@link OutboxPublicationScheduler.scheduleForPublication}
 *   buffers `@Externalized` events and adds them to `@nestjs/outbox`
 *   from one `beforeCommit` hook per transaction, so the messages
 *   commit with the business write and a rollback skips them.
 *
 * `AggregateRoot.commit()` is synchronous, so the outbox write cannot be
 * awaited here. An error from the `beforeCommit` hook still bubbles up
 * and rolls the transaction back, which is the intended behaviour.
 */
@Injectable()
export class HybridEventPublisher implements IEventPublisher {
  constructor(
    private readonly dispatcher: TransactionalEventDispatcher,
    @Optional()
    @Inject(OUTBOX_PUBLICATION_SCHEDULER)
    private readonly outbox?: OutboxPublicationScheduler,
  ) {}

  publish<T extends IEvent>(event: T): void {
    this.dispatcher.scheduleDispatch(event);
    if (this.outbox !== undefined) {
      this.outbox.scheduleForPublication(event);
    }
  }

  publishAll<T extends IEvent>(events: T[]): void {
    for (const event of events) {
      this.publish(event);
    }
  }
}
