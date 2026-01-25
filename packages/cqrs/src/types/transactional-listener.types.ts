import { type Type } from '@nestjs/common';

/**
 * Transaction lifecycle phase at which a {@link TransactionalEventsListener}
 * runs. Mirrors Spring's `TransactionPhase` — see the package README for
 * semantics.
 *
 * - {@link BEFORE_COMMIT}: listener runs before commit; a thrown error causes
 *   the transaction to roll back.
 * - {@link AFTER_COMMIT}: default. Listener runs only after the transaction
 *   has successfully committed. The canonical "publish domain event" phase.
 * - {@link AFTER_ROLLBACK}: listener runs after a rollback.
 * - {@link AFTER_COMPLETION}: listener runs on any completion (commit or
 *   rollback).
 */
export enum TransactionPhase {
  BEFORE_COMMIT = 'BEFORE_COMMIT',
  AFTER_COMMIT = 'AFTER_COMMIT',
  AFTER_ROLLBACK = 'AFTER_ROLLBACK',
  AFTER_COMPLETION = 'AFTER_COMPLETION',
}

/**
 * Options accepted by the {@link TransactionalEventsListener} decorator.
 *
 * @property phase - Lifecycle phase to run the listener in.
 *   Defaults to {@link TransactionPhase.AFTER_COMMIT}.
 * @property fallbackExecution - If `true`, the listener is invoked directly
 *   when the event is published outside any active transaction. If `false`
 *   (the default), such events are dropped with a warning.
 * @property async - Hint that the listener handler is asynchronous. The
 *   dispatcher honours this by awaiting the handler's returned promise.
 *   Defaults to `false`.
 */
export interface TransactionalEventsListenerOptions {
  readonly phase?: TransactionPhase;
  readonly fallbackExecution?: boolean;
  readonly async?: boolean;
}

/**
 * Resolved metadata attached to a method by
 * {@link TransactionalEventsListener}. All option fields are required (the
 * decorator fills in defaults) and the target event type is captured.
 */
export interface TransactionalEventsListenerMetadata extends Required<TransactionalEventsListenerOptions> {
  readonly eventType: Type;
}

/**
 * Metadata key under which {@link TransactionalEventsListener} stores its
 * resolved options on the target method function. Exposed for advanced
 * introspection; most code should use `getTransactionalEventsListenerMetadata`.
 */
export const TRANSACTIONAL_EVENTS_LISTENER_METADATA = Symbol(
  'TRANSACTIONAL_EVENTS_LISTENER_METADATA',
);
