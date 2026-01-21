import 'reflect-metadata';

import { type Type } from '@nestjs/common';

import {
  TRANSACTIONAL_EVENTS_LISTENER_METADATA,
  TransactionPhase,
  type TransactionalEventsListenerMetadata,
  type TransactionalEventsListenerOptions,
} from '../types/transactional-listener.types';

/**
 * Mark a method as a listener for a domain event that participates in the
 * surrounding transaction's lifecycle.
 *
 * **Metadata-only**: this decorator does NOT subscribe the method to any bus
 * at decoration time. The actual subscription and phase routing is performed
 * at runtime by `TransactionalEventDispatcher` and `CqrsHandlerWrapper`
 * (added in later iterations of Phase 3).
 *
 * Defaults:
 * - `phase`: {@link TransactionPhase.AFTER_COMMIT}
 * - `fallbackExecution`: `false`
 * - `async`: `false`
 *
 * @example
 * ```ts
 * @Injectable()
 * export class OrderNotifications {
 *   @TransactionalEventsListener(OrderPlaced)
 *   async onPlaced(event: OrderPlaced): Promise<void> {
 *     // runs only after the transaction that emitted OrderPlaced commits
 *   }
 * }
 * ```
 */
export function TransactionalEventsListener<T = unknown>(
  eventType: Type<T>,
  options: TransactionalEventsListenerOptions = {},
): MethodDecorator {
  const metadata: TransactionalEventsListenerMetadata = {
    eventType,
    phase: options.phase ?? TransactionPhase.AFTER_COMMIT,
    fallbackExecution: options.fallbackExecution ?? false,
    async: options.async ?? false,
  };

  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void => {
    const methodTarget: unknown = descriptor.value;
    if (typeof methodTarget !== 'function') {
      return;
    }
    Reflect.defineMetadata(TRANSACTIONAL_EVENTS_LISTENER_METADATA, metadata, methodTarget);
  };
}

/**
 * Read the {@link TransactionalEventsListenerMetadata} stored by
 * {@link TransactionalEventsListener} on `target`. Returns `undefined` when
 * the target was not decorated.
 *
 * @param target - The method function (typically `Class.prototype.method`)
 *   previously decorated with `@TransactionalEventsListener`.
 */
export function getTransactionalEventsListenerMetadata(
  target: object,
): TransactionalEventsListenerMetadata | undefined {
  const value: unknown = Reflect.getMetadata(TRANSACTIONAL_EVENTS_LISTENER_METADATA, target);
  return value as TransactionalEventsListenerMetadata | undefined;
}
