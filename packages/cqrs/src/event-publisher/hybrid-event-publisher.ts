import { Inject, Injectable, Optional } from '@nestjs/common';
import type { IEvent, IEventPublisher } from '@nestjs/cqrs';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';

/**
 * Minimal structural contract for the outbox-side publisher. Declared
 * here (and injected via the {@link OUTBOX_PUBLICATION_SCHEDULER}
 * token) rather than importing from
 * `@nestjs-transactional/outbox-core` directly — keeps `cqrs` usable
 * without pulling in the outbox stack.
 *
 * `@nestjs-transactional/outbox-core`'s `OutboxEventPublisher`
 * satisfies this interface structurally (it exposes
 * `scheduleForPublication`). Wire the token in the host application
 * when the outbox is enabled:
 *
 * ```ts
 * providers: [
 *   {
 *     provide: OUTBOX_PUBLICATION_SCHEDULER,
 *     useExisting: OutboxEventPublisher,
 *   },
 * ]
 * ```
 */
export interface OutboxPublicationScheduler {
  scheduleForPublication(event: unknown): void;
}

/**
 * DI token for the optional outbox scheduler injected into
 * {@link HybridEventPublisher}. When unbound, the hybrid publisher
 * delegates only to the in-memory dispatcher.
 */
export const OUTBOX_PUBLICATION_SCHEDULER = Symbol('OUTBOX_PUBLICATION_SCHEDULER');

/**
 * `IEventPublisher` implementation that routes aggregate-emitted
 * events through BOTH the in-memory transactional dispatcher
 * (`@TransactionalEventsHandler`) AND — when wired — the outbox
 * (`@OutboxEventsHandler`, introduced in a later phase). Both paths
 * run inside the surrounding transaction:
 *
 * - In-memory: the dispatcher attaches hooks to the current
 *   transaction so listeners fire at the configured phase
 *   (`AFTER_COMMIT` by default). No database rows are written.
 * - Outbox: {@link OutboxPublicationScheduler.scheduleForPublication}
 *   buffers the event and flushes the buffer via one `beforeCommit`
 *   hook per transaction. Publication rows commit atomically with
 *   the business write; rollback skips the flush.
 *
 * When no outbox scheduler is bound, behaves identically to
 * {@link TransactionalEventPublisher}. Callers get outbox semantics
 * automatically as soon as the scheduler is wired — no code change
 * at the call site.
 *
 * Important: the outbox path is best-effort from the perspective of
 * `AggregateRoot.commit()`. `commit()` is synchronous, so we cannot
 * await the DB write here. Errors raised while the `beforeCommit`
 * hook flushes the buffer DO bubble up — they cause the transaction
 * to roll back, which is the intended behavior.
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
