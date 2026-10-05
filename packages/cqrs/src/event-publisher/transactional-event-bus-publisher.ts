import type { IEvent, IEventPublisher } from '@nestjs/cqrs';

import type { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher.js';

import type { OutboxPublicationScheduler } from './outbox-publication-scheduler.js';

/** What {@link TransactionalEventBusPublisher.attach} needs, once DI has built it. */
export interface TransactionalEventBusPublisherDependencies {
  readonly dispatcher: TransactionalEventDispatcher;
  /** The publisher that delivers to `@EventsHandler`s and sagas. */
  readonly inner: IEventPublisher;
  readonly outbox?: OutboxPublicationScheduler;
}

/**
 * The publisher behind `@nestjs/cqrs`'s `EventBus` while
 * `TransactionalCqrsModule` is imported (ADR-024, DD-029). Every event
 * the bus publishes, from `AggregateRoot.commit()` or `eventBus.publish()`
 * alike, passes through it:
 *
 * 1. `@TransactionalEventsHandler` and `@IntegrationEventsHandler`
 *    listeners are scheduled for their transaction phase;
 * 2. an `@Externalized` event is scheduled for the outbox, when
 *    `@nestjs-transactional/outbox` is wired;
 * 3. the event is handed on at once to `@EventsHandler`s and sagas,
 *    exactly as `@nestjs/cqrs`'s own in-memory publisher would.
 *
 * It is installed through `CqrsModule.forRoot({ eventPublisher })`, so
 * `EventBus` holds it from its constructor on, and a publisher that wraps
 * `EventBus.publisher` later (`@nestjs/workflows`' `WorkflowsCqrsModule`)
 * wraps this one. Its collaborators come from DI afterwards, through
 * {@link attach}.
 */
export class TransactionalEventBusPublisher implements IEventPublisher {
  private dependencies: TransactionalEventBusPublisherDependencies | undefined;

  /**
   * @param delegate The application's own publisher, from
   *   `TransactionalCqrsModule.forRoot({ eventPublisher })`. It replaces
   *   the in-memory delivery to `@EventsHandler`s, as it would have
   *   replaced `@nestjs/cqrs`'s default publisher.
   */
  constructor(readonly delegate?: IEventPublisher) {}

  attach(dependencies: TransactionalEventBusPublisherDependencies): void {
    this.dependencies = dependencies;
  }

  /** The publisher events are handed on to after scheduling. */
  get inner(): IEventPublisher | undefined {
    return this.dependencies?.inner;
  }

  publish<T extends IEvent>(
    event: T,
    dispatcherContext?: unknown,
    asyncContext?: unknown,
  ): unknown {
    const { dispatcher, inner, outbox } = this.require();
    dispatcher.scheduleDispatch(event);
    outbox?.scheduleForPublication(event);
    return (inner.publish as (...args: unknown[]) => unknown)(
      event,
      dispatcherContext,
      asyncContext,
    );
  }

  publishAll<T extends IEvent>(
    events: T[],
    dispatcherContext?: unknown,
    asyncContext?: unknown,
  ): unknown {
    const results = (events ?? []).map((event) =>
      this.publish(event, dispatcherContext, asyncContext),
    );
    return results.some(isThenable) ? Promise.all(results) : results;
  }

  private require(): TransactionalEventBusPublisherDependencies {
    if (this.dependencies === undefined) {
      throw new Error(
        'TransactionalEventBusPublisher received an event before TransactionalCqrsModule ' +
          'finished initialising. Publish events from lifecycle hooks (onModuleInit and later), ' +
          'not from provider constructors.',
      );
    }
    return this.dependencies;
  }
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}
