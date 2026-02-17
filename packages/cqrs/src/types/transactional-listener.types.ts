/**
 * Transaction lifecycle phase at which a `@TransactionalEventsHandler`
 * runs. Mirrors Spring's `TransactionPhase` — see the package README
 * for semantics.
 *
 * - {@link BEFORE_COMMIT}: handler runs before commit; a thrown error
 *   causes the transaction to roll back (unless `async: true`).
 * - {@link AFTER_COMMIT}: default. Handler runs only after the
 *   transaction has successfully committed. The canonical "publish
 *   domain event" phase.
 * - {@link AFTER_ROLLBACK}: handler runs after a rollback.
 * - {@link AFTER_COMPLETION}: handler runs on any completion (commit
 *   or rollback).
 */
export enum TransactionPhase {
  BEFORE_COMMIT = 'BEFORE_COMMIT',
  AFTER_COMMIT = 'AFTER_COMMIT',
  AFTER_ROLLBACK = 'AFTER_ROLLBACK',
  AFTER_COMPLETION = 'AFTER_COMPLETION',
}
