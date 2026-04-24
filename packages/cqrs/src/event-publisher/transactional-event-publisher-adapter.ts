import { Injectable } from '@nestjs/common';
import {
  AggregateRoot,
  EventBus,
  EventPublisher,
  type IEvent,
  type IEventPublisher,
} from '@nestjs/cqrs';

// Mirrors @nestjs/cqrs's internal `Constructor` type used by
// `EventPublisher.mergeClassContext`'s signature. Re-declared here so we
// don't import a non-public type from the CQRS package.
type AggregateConstructor<T extends AggregateRoot> = new (...args: never[]) => T;

/**
 * Drop-in replacement for `@nestjs/cqrs`'s `EventPublisher`. Wired
 * automatically by `CqrsTransactionalModule` via
 * `{ provide: EventPublisher, useFactory: ... }`.
 *
 * Override strategy:
 * - `mergeObjectContext` / `mergeClassContext` replace `publish` and
 *   `publishAll` on the aggregate with calls into the injected
 *   {@link IEventPublisher} strategy —
 *   {@link HybridEventPublisher} (default, bridges to both the
 *   in-memory dispatcher and the outbox) or
 *   {@link TransactionalEventPublisher} (in-memory only, legacy).
 * - The parent `EventPublisher.eventBus` is still injected (required
 *   by the base class constructor) but is not used by our override —
 *   events flow exclusively through the configured strategy.
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
    private readonly strategy: IEventPublisher,
    eventBus: EventBus,
  ) {
    super(eventBus);
  }

  mergeClassContext<T extends AggregateConstructor<AggregateRoot>>(metatype: T): T {
    const strategy = this.strategy;

    class TransactionalMerged extends (metatype as AggregateConstructor<AggregateRoot>) {
      publish<TEvent extends IEvent>(event: TEvent): void {
        strategy.publish(event);
      }
      publishAll<TEvent extends IEvent>(events: TEvent[]): void {
        strategy.publishAll?.(events);
      }
    }

    return TransactionalMerged as unknown as T;
  }

  mergeObjectContext<T extends AggregateRoot>(object: T): T {
    const strategy = this.strategy;
    const host = object as unknown as {
      publish: (event: IEvent) => void;
      publishAll: (events: IEvent[]) => void;
    };
    host.publish = (event: IEvent): void => {
      strategy.publish(event);
    };
    host.publishAll = (events: IEvent[]): void => {
      strategy.publishAll?.(events);
    };
    return object;
  }
}
