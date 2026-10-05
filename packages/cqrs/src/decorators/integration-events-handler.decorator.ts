import 'reflect-metadata';

import { type Type } from '@nestjs/common';
import { DEFAULT_DATA_SOURCE_NAME } from '@nestjs-transactional/core';

/**
 * Metadata key under which {@link IntegrationEventsHandlerMetadata} is
 * stored on classes decorated with {@link IntegrationEventsHandler}.
 */
export const INTEGRATION_EVENTS_HANDLER_METADATA = Symbol('INTEGRATION_EVENTS_HANDLER_METADATA');

/**
 * Options accepted by the long form of {@link IntegrationEventsHandler}.
 */
export interface IntegrationEventsHandlerOptions {
  /** Domain event classes the handler subscribes to. Must be non-empty. */
  readonly events: Type[];
  /**
   * dataSource whose transaction the handler waits for: it runs after
   * that transaction commits. Defaults to `'default'`.
   */
  readonly dataSource?: string;
}

/**
 * Resolved metadata attached to a handler class.
 */
export interface IntegrationEventsHandlerMetadata {
  readonly eventTypes: Type[];
  readonly dataSource: string;
}

/**
 * Handler for cross-module integration events: it runs after the
 * publishing transaction commits, asynchronously, in a transaction of
 * its own. The NestJS-idiomatic counterpart of Spring Modulith's
 * `@ApplicationModuleListener`, see "Naming" below.
 *
 * ```ts
 * @IntegrationEventsHandler(OrderPlacedEvent)
 * export class InventoryReservationHandler
 *   implements IIntegrationEventHandler<OrderPlacedEvent>
 * {
 *   async handle(event: OrderPlacedEvent): Promise<void> { ... }
 * }
 * ```
 *
 * Delivery is in-memory: a crash between the commit and the handler
 * loses the call. When the work must survive that, publish the event
 * through `@nestjs-transactional/outbox` and handle it with
 * `@nestjs/outbox`'s `@OnOutboxMessage`, which retries, deduplicates and
 * dead-letters. Until 2.x this decorator switched to a durable outbox
 * path by itself when the outbox was wired; from 3.0.0 delivery belongs
 * to `@nestjs/outbox` (ADR-023).
 *
 * Behaviour is opinionated and fixed: AFTER_COMMIT phase, async
 * execution, a new transaction. If you need any of those to differ, use
 * {@link TransactionalEventsHandler} with explicit options instead.
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
export function IntegrationEventsHandler(options: IntegrationEventsHandlerOptions): ClassDecorator;
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
      dataSource: options.dataSource ?? DEFAULT_DATA_SOURCE_NAME,
    };
  }

  return {
    eventTypes: args as Type[],
    dataSource: DEFAULT_DATA_SOURCE_NAME,
  };
}

function isOptionsObject(candidate: unknown): candidate is IntegrationEventsHandlerOptions {
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
