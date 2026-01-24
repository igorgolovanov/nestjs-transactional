import { Injectable } from '@nestjs/common';
import type { IEvent, IEventPublisher } from '@nestjs/cqrs';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';

/**
 * `IEventPublisher` implementation that routes aggregate-emitted events
 * to {@link TransactionalEventDispatcher} instead of pushing them straight
 * into the `@nestjs/cqrs` `EventBus`.
 *
 * The dispatcher then attaches each event as a hook on the active
 * transaction — so `AFTER_COMMIT` listeners only fire once the
 * transaction commits, `AFTER_ROLLBACK` fires on rollback, etc.
 *
 * The class itself is the "strategy" half of the pair; it does not
 * override `@nestjs/cqrs`'s `EventPublisher` by itself. The override is
 * done by {@link TransactionalEventPublisherAdapter}, which injects this
 * publisher into the aggregate-root merge path.
 */
@Injectable()
export class TransactionalEventPublisher implements IEventPublisher {
  constructor(private readonly dispatcher: TransactionalEventDispatcher) {}

  /**
   * Route a single aggregate event through the dispatcher. Intentionally
   * synchronous: `IEventPublisher.publish` may return anything, and the
   * dispatcher's own scheduling is sync (hooks attach synchronously;
   * invocation is deferred to commit/rollback time).
   */
  publish<T extends IEvent>(event: T): void {
    this.dispatcher.scheduleDispatch(event);
  }

  /**
   * Route a list of aggregate events through the dispatcher, preserving
   * their order (listeners fire in the order the aggregate emitted them).
   */
  publishAll<T extends IEvent>(events: T[]): void {
    for (const event of events) {
      this.publish(event);
    }
  }
}
