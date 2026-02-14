import 'reflect-metadata';

import { type Type } from '@nestjs/common';

import {
  TRANSACTIONAL_EVENTS_LISTENER_METADATA,
  TransactionPhase,
  type TransactionalEventsListenerMetadata,
} from '../types/transactional-listener.types';

/**
 * Globally-unique metadata key shared with
 * `@nestjs-transactional/outbox-core`'s `@OutboxEventListener`. Derived
 * via `Symbol.for(...)` so the two packages refer to the same key
 * without a hard type-level dependency. The shape written here must
 * stay byte-compatible with `OutboxEventListenerMetadata` from
 * outbox-core — see CLAUDE.md convention #8 on well-known shared
 * symbols.
 */
const OUTBOX_EVENT_LISTENER_METADATA_KEY = Symbol.for(
  '@nestjs-transactional/outbox-event-listener-metadata',
);

/**
 * Structural shape of the outbox listener metadata. Mirrors
 * `OutboxEventListenerMetadata` from `@nestjs-transactional/outbox-core`
 * — duplicated locally so this module can produce compatible metadata
 * without importing outbox-core (which is an optional consumer-side
 * peer).
 */
interface OutboxListenerMetadataShape {
  readonly eventType: Type<object>;
  readonly id?: string;
  readonly newTransaction: boolean;
}

/** Options accepted by {@link ApplicationModuleListener}. */
export interface ApplicationModuleListenerOptions {
  /**
   * Stable, globally-unique listener id used by the outbox registry
   * to resolve which method to invoke for a stored publication. When
   * omitted, the outbox scanner derives one from `${class}.${method}`.
   * Supply an explicit id if you expect to rename the method — the
   * derived id is not stable across renames.
   */
  readonly id?: string;
}

/**
 * Spring Modulith-equivalent composite decorator — the recommended
 * default for cross-module integration listeners in NestJS
 * applications on this stack.
 *
 * Combines three behaviours:
 *
 * 1. **Persistent, at-least-once delivery** — via the outbox, when
 *    `@nestjs-transactional/outbox-core` is wired. The method is
 *    registered as an `@OutboxEventListener` with
 *    `newTransaction: true`, so publications commit atomically with
 *    the publishing transaction, survive process restarts, and
 *    auto-retry on failure.
 *
 * 2. **In-memory fallback** — via `@TransactionalEventsListener` with
 *    `phase: AFTER_COMMIT`. When the outbox is NOT wired, the
 *    listener still runs after the publishing transaction commits —
 *    just without the persistence guarantee. When the outbox IS
 *    wired, `TransactionalListenerScanner` detects the overlap and
 *    skips the in-memory registration so the listener runs exactly
 *    once.
 *
 * 3. **Fresh transaction per invocation** — `REQUIRES_NEW`
 *    semantics, matching Spring Modulith's contract that module
 *    boundaries should not share transaction state.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class InventoryHandlers {
 *   @ApplicationModuleListener(OrderPlacedEvent)
 *   async reserveStock(event: OrderPlacedEvent): Promise<void> {
 *     // with outbox: runs from the worker, retried on failure,
 *     //   resumable across restarts.
 *     // without outbox: runs in-memory after commit, fire-and-forget.
 *   }
 * }
 * ```
 */
export function ApplicationModuleListener<T extends object>(
  eventType: Type<T>,
  options: ApplicationModuleListenerOptions = {},
): MethodDecorator {
  const outboxMetadata: OutboxListenerMetadataShape = {
    eventType,
    id: options.id,
    newTransaction: true,
  };

  const transactionalMetadata: TransactionalEventsListenerMetadata = {
    eventType,
    phase: TransactionPhase.AFTER_COMMIT,
    fallbackExecution: false,
    async: true,
  };

  return (_target: object, _propertyKey: string | symbol, descriptor: PropertyDescriptor): void => {
    const methodTarget: unknown = descriptor.value;
    if (typeof methodTarget !== 'function') {
      return;
    }
    Reflect.defineMetadata(OUTBOX_EVENT_LISTENER_METADATA_KEY, outboxMetadata, methodTarget);
    Reflect.defineMetadata(
      TRANSACTIONAL_EVENTS_LISTENER_METADATA,
      transactionalMetadata,
      methodTarget,
    );
  };
}

/**
 * Predicate: does the method carry outbox-listener metadata (either
 * from `@OutboxEventListener` or as the outbox half of
 * `@ApplicationModuleListener`)? Used by
 * `TransactionalListenerScanner` to decide whether to defer delivery
 * to the outbox worker when both the outbox scheduler and the
 * in-memory dispatcher could handle the same method.
 */
export function hasOutboxListenerMetadata(target: object): boolean {
  return Reflect.hasMetadata(OUTBOX_EVENT_LISTENER_METADATA_KEY, target);
}
