import 'reflect-metadata';

import { type Type } from '@nestjs/common';

/**
 * Metadata key under which {@link ApplicationModuleHandlerMetadata} is
 * stored on classes decorated with {@link ApplicationModuleHandler}.
 *
 * Private to the cqrs package — not shared with outbox-core (the
 * smart scanner routes the handler based on whether a registrar is
 * bound, not by inspecting shared metadata).
 */
export const APPLICATION_MODULE_HANDLER_METADATA = Symbol(
  'APPLICATION_MODULE_HANDLER_METADATA',
);

/**
 * Options accepted by the long form of {@link ApplicationModuleHandler}.
 */
export interface ApplicationModuleHandlerOptions {
  /** Domain event classes the handler subscribes to. Must be non-empty. */
  readonly events: Type[];
  /**
   * Stable, globally-unique listener id used by the outbox registry to
   * resolve which handler to invoke for a stored publication. When
   * omitted, the scanner derives one from
   * `${ClassName}#${EventName}` per event type — a rename of the class
   * therefore breaks resume of already-stored publications. Supply an
   * explicit id to protect against this. When multiple events are
   * declared, the scanner appends `#${EventName}` to the supplied id.
   */
  readonly id?: string;
}

/**
 * Resolved metadata attached to a handler class.
 */
export interface ApplicationModuleHandlerMetadata {
  readonly eventTypes: Type[];
  readonly id?: string;
}

/**
 * Spring Modulith-equivalent smart-default decorator for cross-module
 * event handlers.
 *
 * Behaviour depends on module wiring, decided at bootstrap by
 * `ApplicationModuleHandlerScanner`:
 *
 * 1. **Outbox wired** (the `OUTBOX_LISTENER_REGISTRAR` provider is
 *    bound, typically via `OutboxModule`): the handler is registered
 *    as a persistent outbox listener with `newTransaction: true`
 *    semantics. Delivery is durable, at-least-once, retried on
 *    failure, and survives process restarts.
 *
 * 2. **Outbox NOT wired**: the handler is registered in-memory via
 *    `TransactionalEventDispatcher` with `phase: AFTER_COMMIT`,
 *    `async: true`, and wrapped in a `REQUIRES_NEW` transaction —
 *    mirroring the outbox-backed behaviour as closely as in-memory
 *    dispatch allows (minus persistence).
 *
 * Either way, consumer code is identical:
 *
 * ```ts
 * @ApplicationModuleHandler(OrderPlacedEvent)
 * export class InventoryReservationHandler
 *   implements IApplicationModuleHandler<OrderPlacedEvent>
 * {
 *   async handle(event: OrderPlacedEvent): Promise<void> { ... }
 * }
 * ```
 *
 * Two forms:
 *
 * ```ts
 * // Short form:
 * @ApplicationModuleHandler(OrderPlacedEvent, OrderCancelledEvent)
 *
 * // Long form with stable id:
 * @ApplicationModuleHandler({
 *   events: [OrderPlacedEvent],
 *   id: 'inventory.reservation',
 * })
 * ```
 *
 * @throws {Error} If no event types are supplied.
 */
export function ApplicationModuleHandler(...events: Type[]): ClassDecorator;
export function ApplicationModuleHandler(
  options: ApplicationModuleHandlerOptions,
): ClassDecorator;
export function ApplicationModuleHandler(
  ...args: [ApplicationModuleHandlerOptions] | Type[]
): ClassDecorator {
  const metadata: ApplicationModuleHandlerMetadata = resolveMetadata(args);

  if (metadata.eventTypes.length === 0) {
    throw new Error(
      '@ApplicationModuleHandler requires at least one event type. ' +
        'Pass class constructors as rest arguments or via the `events` option.',
    );
  }

  return (target: object): void => {
    Reflect.defineMetadata(APPLICATION_MODULE_HANDLER_METADATA, metadata, target);
  };
}

function resolveMetadata(
  args: [ApplicationModuleHandlerOptions] | Type[],
): ApplicationModuleHandlerMetadata {
  if (args.length === 1 && isOptionsObject(args[0])) {
    const options = args[0];
    return {
      eventTypes: [...options.events],
      id: options.id,
    };
  }

  return {
    eventTypes: args as Type[],
  };
}

function isOptionsObject(
  candidate: unknown,
): candidate is ApplicationModuleHandlerOptions {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof candidate !== 'function' &&
    'events' in candidate
  );
}

/**
 * Read the {@link ApplicationModuleHandlerMetadata} attached to
 * `target` by {@link ApplicationModuleHandler}. Returns `undefined`
 * when the class was not decorated.
 */
export function getApplicationModuleHandlerMetadata(
  target: object,
): ApplicationModuleHandlerMetadata | undefined {
  const value: unknown = Reflect.getMetadata(APPLICATION_MODULE_HANDLER_METADATA, target);
  return value as ApplicationModuleHandlerMetadata | undefined;
}
