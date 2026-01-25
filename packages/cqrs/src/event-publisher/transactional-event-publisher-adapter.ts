import { Injectable } from '@nestjs/common';
import { AggregateRoot, EventBus, EventPublisher, type IEvent } from '@nestjs/cqrs';

import { TransactionalEventPublisher } from './transactional-event-publisher';

// Mirrors @nestjs/cqrs's internal `Constructor` type used by
// `EventPublisher.mergeClassContext`'s signature. Re-declared here so we
// don't import a non-public type from the CQRS package.
type AggregateConstructor<T extends AggregateRoot> = new (...args: never[]) => T;

/**
 * Drop-in replacement for `@nestjs/cqrs`'s `EventPublisher`. Wire it via
 * `{ provide: EventPublisher, useClass: TransactionalEventPublisherAdapter }`
 * (done automatically by `CqrsTransactionalModule` in a later iteration).
 *
 * Override strategy:
 * - `mergeObjectContext` / `mergeClassContext` replace `publish` and
 *   `publishAll` on the aggregate with calls into
 *   {@link TransactionalEventPublisher}, which forwards to
 *   {@link import('../event-dispatcher/event-dispatcher').TransactionalEventDispatcher}.
 * - The parent `EventPublisher.eventBus` is still injected (required by
 *   the base class constructor) but is not used by our override — events
 *   flow exclusively through the dispatcher.
 *
 * Note: consumers calling `eventBus.publish(...)` directly (outside of an
 * aggregate) still go through the original `@nestjs/cqrs` `EventBus` and
 * bypass phase-aware dispatching. Only aggregate-emitted events routed
 * via `mergeObjectContext` / `mergeClassContext` get transactional
 * semantics.
 */
@Injectable()
export class TransactionalEventPublisherAdapter extends EventPublisher {
  constructor(
    private readonly transactionalPublisher: TransactionalEventPublisher,
    eventBus: EventBus,
  ) {
    super(eventBus);
  }

  mergeClassContext<T extends AggregateConstructor<AggregateRoot>>(metatype: T): T {
    const publisher = this.transactionalPublisher;

    class TransactionalMerged extends (metatype as AggregateConstructor<AggregateRoot>) {
      publish<TEvent extends IEvent>(event: TEvent): void {
        publisher.publish(event);
      }
      publishAll<TEvent extends IEvent>(events: TEvent[]): void {
        publisher.publishAll(events);
      }
    }

    return TransactionalMerged as unknown as T;
  }

  mergeObjectContext<T extends AggregateRoot>(object: T): T {
    const publisher = this.transactionalPublisher;
    const host = object as unknown as {
      publish: (event: IEvent) => void;
      publishAll: (events: IEvent[]) => void;
    };
    host.publish = (event: IEvent): void => publisher.publish(event);
    host.publishAll = (events: IEvent[]): void => publisher.publishAll(events);
    return object;
  }
}
