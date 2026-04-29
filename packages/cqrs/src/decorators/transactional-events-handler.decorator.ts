import 'reflect-metadata';

import { type Type } from '@nestjs/common';
import { DEFAULT_DATA_SOURCE_NAME } from '@nestjs-transactional/core';

import { TransactionPhase } from '../types/transactional-listener.types';

/**
 * Metadata key under which {@link TransactionalEventsHandlerMetadata} is
 * stored on classes decorated with {@link TransactionalEventsHandler}.
 *
 * The key is a fresh `Symbol` (not `Symbol.for`) — this metadata is
 * private to the cqrs package and does not need to be shared across
 * package boundaries.
 */
export const TRANSACTIONAL_EVENTS_HANDLER_METADATA = Symbol(
  'TRANSACTIONAL_EVENTS_HANDLER_METADATA',
);

/**
 * Options accepted by the long form of {@link TransactionalEventsHandler}.
 *
 * Use this form when the handler needs any non-default behaviour (a
 * different `phase`, `async` delivery, or `fallbackExecution` outside a
 * transaction). When defaults are acceptable, prefer the rest-params
 * short form: `@TransactionalEventsHandler(EventA, EventB)`.
 */
export interface TransactionalEventsHandlerOptions {
  /** Domain event classes the handler subscribes to. Must be non-empty. */
  readonly events: Type[];
  /**
   * Transaction phase to attach the handler to. Defaults to
   * {@link TransactionPhase.AFTER_COMMIT} — the canonical "publish
   * domain event" phase.
   */
  readonly phase?: TransactionPhase;
  /**
   * When `true`, the handler is invoked on a microtask and its failures
   * never reach the surrounding transaction — including BEFORE_COMMIT,
   * which therefore cannot cause a rollback. Defaults to `false`.
   */
  readonly async?: boolean;
  /**
   * When `true`, the handler fires even for events published outside
   * any active transaction (direct `eventBus.publish(event)` calls).
   * When `false` (default), such events are dropped with a warning.
   */
  readonly fallbackExecution?: boolean;
  /**
   * dataSource the handler's phase hooks attach to (Phase 14.3.1).
   * Defaults to {@link DEFAULT_DATA_SOURCE_NAME} (`'default'`) —
   * single-dataSource apps can omit it.
   *
   * Multi-dataSource apps with handlers belonging to a non-default
   * dataSource MUST set this — the dispatcher uses it to find the
   * matching active transaction via
   * `TransactionContext.getActiveTransactionByDataSource(dataSource)`
   * and pushes phase hooks directly onto that transaction's hook
   * lists. Without it, the dispatcher falls back to `'default'` and
   * the handler may attach to the wrong transaction (or none at all
   * if the default-DS has no active tx in the current async context).
   *
   * Unlike `@OutboxEventsHandler` and `@IntegrationEventsHandler`'s
   * outbox path — both of which auto-resolve the dataSource by
   * walking per-DS event-type registries — the in-memory dispatcher
   * has no event-type registry to consult. The cqrs package is
   * decoupled from outbox by design (Phase 14.7), so the dataSource
   * is declared explicitly on the decorator.
   */
  readonly dataSource?: string;
}

/**
 * Resolved metadata attached to a handler class. All option fields are
 * required (the decorator fills in defaults). `eventTypes` is the
 * normalised list of event constructors the handler is registered for.
 */
export interface TransactionalEventsHandlerMetadata {
  readonly eventTypes: Type[];
  readonly phase: TransactionPhase;
  readonly async: boolean;
  readonly fallbackExecution: boolean;
  readonly dataSource: string;
}

/**
 * Mark a class as a transactional event handler. The class must
 * expose a `handle(event): void | Promise<void>` method (enforce this
 * at the type level by implementing {@link ITransactionalEventHandler}).
 *
 * Two forms:
 *
 * ```ts
 * // Short form — defaults (AFTER_COMMIT, sync, no fallback):
 * @TransactionalEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
 *
 * // Long form — explicit options:
 * @TransactionalEventsHandler({
 *   events: [OrderPlacedEvent],
 *   phase: TransactionPhase.BEFORE_COMMIT,
 *   async: false,
 * })
 * ```
 *
 * Class-level only — this decorator does not accept methods. Multiple
 * handlers may subscribe to the same event type; each is an independent
 * class and runs in registration order.
 *
 * The metadata is written by `Reflect.defineMetadata`. The actual
 * dispatcher registration happens at application bootstrap via
 * `TransactionalListenerScanner`.
 *
 * **Multi-dataSource semantics (Phase 14.3.1).** The dispatcher pushes
 * phase hooks directly onto the per-dataSource active transaction
 * resolved via
 * `TransactionContext.getActiveTransactionByDataSource(dataSource)`,
 * bypassing `TransactionManager.registerBeforeCommit`'s first-active-tx
 * semantics. The dataSource defaults to `'default'`; multi-DS apps
 * pass `dataSource: 'billing'` (or similar) on the long form to attach
 * the handler to a specific dataSource's transaction:
 *
 * ```ts
 * @TransactionalEventsHandler({
 *   events: [BillingEvent],
 *   dataSource: 'billing',
 * })
 * class BillingHandler { handle(event: BillingEvent) {} }
 * ```
 *
 * Unlike `@OutboxEventsHandler` (which auto-resolves the dataSource
 * by walking per-DS event-type registries), the in-memory dispatcher
 * has no event-type registry — the dataSource is declared explicitly
 * on the decorator.
 *
 * @throws {Error} If no event types are supplied.
 */
export function TransactionalEventsHandler(...events: Type[]): ClassDecorator;
export function TransactionalEventsHandler(
  options: TransactionalEventsHandlerOptions,
): ClassDecorator;
export function TransactionalEventsHandler(
  ...args: [TransactionalEventsHandlerOptions] | Type[]
): ClassDecorator {
  const metadata: TransactionalEventsHandlerMetadata = resolveMetadata(args);

  if (metadata.eventTypes.length === 0) {
    throw new Error(
      '@TransactionalEventsHandler requires at least one event type. ' +
        'Pass class constructors as rest arguments or via the `events` option.',
    );
  }

  return (target: object): void => {
    Reflect.defineMetadata(TRANSACTIONAL_EVENTS_HANDLER_METADATA, metadata, target);
  };
}

function resolveMetadata(
  args: [TransactionalEventsHandlerOptions] | Type[],
): TransactionalEventsHandlerMetadata {
  if (args.length === 1 && isOptionsObject(args[0])) {
    const options = args[0];
    return {
      eventTypes: [...options.events],
      phase: options.phase ?? TransactionPhase.AFTER_COMMIT,
      async: options.async ?? false,
      fallbackExecution: options.fallbackExecution ?? false,
      dataSource: options.dataSource ?? DEFAULT_DATA_SOURCE_NAME,
    };
  }

  return {
    eventTypes: args as Type[],
    phase: TransactionPhase.AFTER_COMMIT,
    async: false,
    fallbackExecution: false,
    dataSource: DEFAULT_DATA_SOURCE_NAME,
  };
}

function isOptionsObject(
  candidate: unknown,
): candidate is TransactionalEventsHandlerOptions {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof candidate !== 'function' &&
    'events' in candidate
  );
}

/**
 * Read the {@link TransactionalEventsHandlerMetadata} attached to
 * `target` by {@link TransactionalEventsHandler}. Returns `undefined`
 * when the class was not decorated.
 *
 * @param target - The class constructor.
 */
export function getTransactionalEventsHandlerMetadata(
  target: object,
): TransactionalEventsHandlerMetadata | undefined {
  const value: unknown = Reflect.getMetadata(TRANSACTIONAL_EVENTS_HANDLER_METADATA, target);
  return value as TransactionalEventsHandlerMetadata | undefined;
}
