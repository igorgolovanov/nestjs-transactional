import 'reflect-metadata';

import { type Type } from '@nestjs/common';

/**
 * Metadata key under which {@link IntegrationEventsHandlerMetadata} is
 * stored on classes decorated with {@link IntegrationEventsHandler}.
 *
 * Private to the cqrs package — not shared with outbox-core (the
 * smart scanner routes the handler based on whether a registrar is
 * bound, not by inspecting shared metadata).
 */
export const INTEGRATION_EVENTS_HANDLER_METADATA = Symbol(
  'INTEGRATION_EVENTS_HANDLER_METADATA',
);

/**
 * Options accepted by the long form of {@link IntegrationEventsHandler}.
 */
export interface IntegrationEventsHandlerOptions {
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
export interface IntegrationEventsHandlerMetadata {
  readonly eventTypes: Type[];
  readonly id?: string;
}

/**
 * Smart-default decorator for cross-module / cross-service integration
 * event handlers. The NestJS-idiomatic equivalent of Spring Modulith's
 * `@ApplicationModuleListener` — see "Naming" below.
 *
 * Behaviour depends on module wiring, decided at bootstrap by
 * `IntegrationEventsHandlerScanner`:
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
 * @IntegrationEventsHandler(OrderPlacedEvent)
 * export class InventoryReservationHandler
 *   implements IIntegrationEventsHandler<OrderPlacedEvent>
 * {
 *   async handle(event: OrderPlacedEvent): Promise<void> { ... }
 * }
 * ```
 *
 * Two forms:
 *
 * ```ts
 * // Short form:
 * @IntegrationEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
 *
 * // Long form with stable id:
 * @IntegrationEventsHandler({
 *   events: [OrderPlacedEvent],
 *   id: 'inventory.reservation',
 * })
 * ```
 *
 * Behaviour is opinionated and fixed: AFTER_COMMIT phase, async
 * execution, REQUIRES_NEW transaction. If you need any of those to
 * differ, use {@link TransactionalEventsHandler} with explicit
 * options instead — that decorator exposes the full configuration
 * surface for in-memory event handling.
 *
 * **Naming.** The Spring Modulith decorator with this role is called
 * `@ApplicationModuleListener`. We use `@IntegrationEventsHandler`
 * because (a) "Application Module" overlaps with NestJS's `@Module()`
 * (a DI concept), and (b) "Integration events" is the established
 * DDD/microservices term for cross-module/cross-service event flow.
 *
 * @throws {Error} If no event types are supplied.
 */
export function IntegrationEventsHandler(...events: Type[]): ClassDecorator;
export function IntegrationEventsHandler(
  options: IntegrationEventsHandlerOptions,
): ClassDecorator;
export function IntegrationEventsHandler(
  ...args: [IntegrationEventsHandlerOptions] | Type[]
): ClassDecorator {
  const metadata: IntegrationEventsHandlerMetadata = resolveMetadata(args);

  if (metadata.eventTypes.length === 0) {
    throw new Error(
      '@IntegrationEventsHandler requires at least one event type. ' +
        'Pass class constructors as rest arguments or via the `events` option.',
    );
  }

  return (target: object): void => {
    Reflect.defineMetadata(INTEGRATION_EVENTS_HANDLER_METADATA, metadata, target);
  };
}

function resolveMetadata(
  args: [IntegrationEventsHandlerOptions] | Type[],
): IntegrationEventsHandlerMetadata {
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
): candidate is IntegrationEventsHandlerOptions {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof candidate !== 'function' &&
    'events' in candidate
  );
}

/**
 * Read the {@link IntegrationEventsHandlerMetadata} attached to
 * `target` by {@link IntegrationEventsHandler}. Returns `undefined`
 * when the class was not decorated.
 */
export function getIntegrationEventsHandlerMetadata(
  target: object,
): IntegrationEventsHandlerMetadata | undefined {
  const value: unknown = Reflect.getMetadata(INTEGRATION_EVENTS_HANDLER_METADATA, target);
  return value as IntegrationEventsHandlerMetadata | undefined;
}
