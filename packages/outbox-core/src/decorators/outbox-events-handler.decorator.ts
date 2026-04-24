import 'reflect-metadata';

import { type Type } from '@nestjs/common';

/**
 * Metadata key under which {@link OutboxEventsHandlerMetadata} is
 * stored on classes decorated with {@link OutboxEventsHandler}.
 *
 * Fresh `Symbol` (not `Symbol.for`) — this metadata is read only by
 * outbox-core's own `OutboxListenerScanner`. Cross-package sharing is
 * not required because `@ApplicationModuleHandler` in the cqrs
 * package uses the `OUTBOX_LISTENER_REGISTRAR` structural port, not
 * metadata introspection, to route handlers to the outbox.
 */
export const OUTBOX_EVENTS_HANDLER_METADATA = Symbol('OUTBOX_EVENTS_HANDLER_METADATA');

/**
 * Options accepted by the long form of {@link OutboxEventsHandler}.
 */
export interface OutboxEventsHandlerOptions {
  /** Domain event classes the handler subscribes to. Must be non-empty. */
  readonly events: Type[];
  /**
   * Stable, globally-unique listener id base. When set, the scanner
   * derives the per-event-type id as `${id}#${EventName}`. When
   * omitted, the base id is `${ClassName}` — a rename of the class
   * therefore breaks resume of already-stored publications.
   *
   * The id (after the suffix is appended) is persisted on every
   * `event_publication` row — supply an explicit id to protect
   * against renames in production.
   */
  readonly id?: string;
  /**
   * Run the handler in its own new transaction (`REQUIRES_NEW`
   * semantics). Default: `true` — matches Spring Modulith's
   * `@ApplicationModuleListener` behaviour. Set to `false` to run
   * the handler without opening a transaction (e.g. the handler
   * only calls an idempotent external API).
   */
  readonly newTransaction?: boolean;
}

/**
 * Resolved metadata attached to a handler class.
 */
export interface OutboxEventsHandlerMetadata {
  readonly eventTypes: Type[];
  readonly id?: string;
  readonly newTransaction: boolean;
}

/**
 * Mark a class as a persistent outbox handler. The class must
 * implement {@link IOutboxEventsHandler} — expose a
 * `handle(event): Promise<void>` method.
 *
 * Distinct from `@TransactionalEventsHandler` (cqrs package), which
 * is in-memory and phase-based: `@OutboxEventsHandler` is
 * persistent, always after-commit, and supports retry / recovery on
 * restart. Also distinct from `@ApplicationModuleHandler`, which
 * switches between durable and in-memory delivery based on module
 * wiring — this decorator ALWAYS routes to the outbox (and will
 * fail bootstrap without an outbox registry).
 *
 * Two forms:
 *
 * ```ts
 * // Short form — defaults (newTransaction: true):
 * @OutboxEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
 *
 * // Long form — explicit options:
 * @OutboxEventsHandler({
 *   events: [OrderPlacedEvent],
 *   id: 'inventory.reservation',
 *   newTransaction: false,
 * })
 * ```
 *
 * Class-level only; the metadata is written by
 * `Reflect.defineMetadata`. The actual registration happens at
 * application bootstrap via `OutboxListenerScanner`.
 *
 * @throws {Error} If no event types are supplied.
 */
export function OutboxEventsHandler(...events: Type[]): ClassDecorator;
export function OutboxEventsHandler(options: OutboxEventsHandlerOptions): ClassDecorator;
export function OutboxEventsHandler(
  ...args: [OutboxEventsHandlerOptions] | Type[]
): ClassDecorator {
  const metadata: OutboxEventsHandlerMetadata = resolveMetadata(args);

  if (metadata.eventTypes.length === 0) {
    throw new Error(
      '@OutboxEventsHandler requires at least one event type. ' +
        'Pass class constructors as rest arguments or via the `events` option.',
    );
  }

  return (target: object): void => {
    Reflect.defineMetadata(OUTBOX_EVENTS_HANDLER_METADATA, metadata, target);
  };
}

function resolveMetadata(
  args: [OutboxEventsHandlerOptions] | Type[],
): OutboxEventsHandlerMetadata {
  if (args.length === 1 && isOptionsObject(args[0])) {
    const options = args[0];
    return {
      eventTypes: [...options.events],
      id: options.id,
      newTransaction: options.newTransaction ?? true,
    };
  }

  return {
    eventTypes: args as Type[],
    newTransaction: true,
  };
}

function isOptionsObject(candidate: unknown): candidate is OutboxEventsHandlerOptions {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof candidate !== 'function' &&
    'events' in candidate
  );
}

/**
 * Read the {@link OutboxEventsHandlerMetadata} attached to `target`
 * by {@link OutboxEventsHandler}. Returns `undefined` when the
 * class was not decorated.
 */
export function getOutboxEventsHandlerMetadata(
  target: object,
): OutboxEventsHandlerMetadata | undefined {
  const value: unknown = Reflect.getMetadata(OUTBOX_EVENTS_HANDLER_METADATA, target);
  return value as OutboxEventsHandlerMetadata | undefined;
}
