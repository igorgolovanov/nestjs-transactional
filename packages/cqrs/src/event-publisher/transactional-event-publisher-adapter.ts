import { Injectable } from '@nestjs/common';
import {
  type AsyncContext,
  EventBus,
  EventPublisher,
  type IEvent,
  type IEventPublisher,
} from '@nestjs/cqrs';

// Mirrors @nestjs/cqrs's internal `Constructor` type used by
// `EventPublisher.mergeClassContext`'s signature. Re-declared here so we
// don't import a non-public type from the CQRS package.
//
// Exported because it appears in `mergeClassContext`'s public signature:
// without it a consumer cannot name the constraint on that type
// parameter. api-extractor's `ae-forgotten-export` flagged exactly this.
//
// The constraint is structural rather than `AggregateRoot` on purpose.
// `@nestjs/cqrs` 12 changed `EventPublisher`'s own constraint from the
// concrete `AggregateRoot` class to the `IAggregateRoot` interface, and
// an override narrower than the base it overrides does not compile. What
// the two methods below actually require of the target is that it has
// `publish` / `publishAll` to replace, which both spellings satisfy.
export type AggregateConstructor<T extends object = object> = new (...args: never[]) => T;

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
 *
 * **`asyncContext` is accepted and not used**, on both `@nestjs/cqrs` 11
 * and 12. The base class forwards it to `eventBus.publish(event, this,
 * asyncContext)`, where it selects a request-scoped handler instance.
 * This adapter never reaches that path: `TransactionalEventDispatcher`
 * keeps its own listener registry and binds each handler method to its
 * instance at registration time, so there is no scoped resolution left
 * for an `AsyncContext` to influence. The parameter is declared so the
 * override matches the base signature, and swallowing it silently would
 * be worse than saying so here. Scoped CQRS handlers are not supported
 * through this publisher.
 */
@Injectable()
export class TransactionalEventPublisherAdapter extends EventPublisher {
  constructor(
    private readonly strategy: IEventPublisher,
    eventBus: EventBus,
  ) {
    super(eventBus);
  }

  mergeClassContext<T extends AggregateConstructor>(metatype: T, _asyncContext?: AsyncContext): T {
    const strategy = this.strategy;

    class TransactionalMerged extends (metatype as AggregateConstructor) {
      publish<TEvent extends IEvent>(event: TEvent): void {
        strategy.publish(event);
      }
      publishAll<TEvent extends IEvent>(events: TEvent[]): void {
        strategy.publishAll?.(events);
      }
    }

    return TransactionalMerged as unknown as T;
  }

  mergeObjectContext<T extends object>(object: T, _asyncContext?: AsyncContext): T {
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
