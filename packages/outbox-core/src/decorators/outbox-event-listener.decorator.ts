import 'reflect-metadata';

import { type Type } from '@nestjs/common';

/** Metadata key under which {@link OutboxEventListenerMetadata} is stored on the decorated method. */
export const OUTBOX_EVENT_LISTENER_METADATA = Symbol('OUTBOX_EVENT_LISTENER_METADATA');

/**
 * Options accepted by {@link OutboxEventListener}.
 */
export interface OutboxEventListenerOptions {
  /**
   * Globally-unique listener id. If omitted, the scanner derives one via
   * `${className}.${methodName}`.
   *
   * Must be stable across deployments — the id is persisted on every
   * `event_publication` row and is how retry / recovery knows which
   * method to invoke next time around. Renaming the decorated method
   * without supplying an explicit `id` breaks resolution of existing
   * stored publications.
   */
  readonly id?: string;

  /**
   * Run the listener in its own new transaction (`REQUIRES_NEW`
   * semantics). Default: `true` — matches Spring Modulith's
   * `@ApplicationModuleListener` behaviour.
   */
  readonly newTransaction?: boolean;
}

/**
 * Resolved metadata attached to a decorated method. All option fields
 * except `id` are defaulted — `id === undefined` tells the scanner to
 * derive the id from class + method names.
 */
export interface OutboxEventListenerMetadata
  extends Required<Omit<OutboxEventListenerOptions, 'id'>> {
  readonly eventType: Type<object>;
  readonly id?: string;
}

/**
 * Mark a method as a persistent outbox listener for `eventType`.
 *
 * **Metadata-only**: the decorator does not subscribe the method
 * anywhere at decoration time. At application bootstrap,
 * `OutboxListenerScanner` walks every provider, reads this metadata,
 * and registers the method with `OutboxListenerRegistry`. Actual
 * delivery happens through the event publication registry + async
 * dispatcher (later iterations of Phase 5).
 *
 * Distinct from `@TransactionalEventsListener` (cqrs package), which
 * is in-memory and phase-based: `@OutboxEventListener` is persistent,
 * always-after-commit, and supports retry / recovery on restart.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class InventoryHandlers {
 *   @OutboxEventListener(OrderPlacedEvent)
 *   async reserveStock(event: OrderPlacedEvent): Promise<void> {
 *     // runs inside a fresh REQUIRES_NEW transaction, only after the
 *     // transaction that published OrderPlacedEvent has committed.
 *   }
 * }
 * ```
 */
export function OutboxEventListener<T extends object>(
  eventType: Type<T>,
  options: OutboxEventListenerOptions = {},
): MethodDecorator {
  const metadata: OutboxEventListenerMetadata = {
    eventType,
    id: options.id,
    newTransaction: options.newTransaction ?? true,
  };

  return (_target: object, _propertyKey: string | symbol, descriptor: PropertyDescriptor): void => {
    const methodTarget: unknown = descriptor.value;
    if (typeof methodTarget !== 'function') {
      return;
    }
    Reflect.defineMetadata(OUTBOX_EVENT_LISTENER_METADATA, metadata, methodTarget);
  };
}

/**
 * Read the {@link OutboxEventListenerMetadata} previously attached to
 * `target` by {@link OutboxEventListener}. Returns `undefined` when the
 * target was not decorated.
 */
export function getOutboxEventListenerMetadata(
  target: object,
): OutboxEventListenerMetadata | undefined {
  const value: unknown = Reflect.getMetadata(OUTBOX_EVENT_LISTENER_METADATA, target);
  return value as OutboxEventListenerMetadata | undefined;
}

/**
 * Compose the default listener id used when the decorator was not
 * given an explicit `id`. Exported so consumers can pre-compute the id
 * for explicit registration / tests.
 */
export function deriveListenerId(className: string, methodName: string): string {
  return `${className}.${methodName}`;
}
