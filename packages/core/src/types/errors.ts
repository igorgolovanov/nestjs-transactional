/**
 * Base class for all errors thrown by `@nestjs-transactional` packages.
 * Every subclass carries a stable {@link code} suitable for structured
 * logging, metrics, and NestJS exception filters.
 *
 * The constructor sets `this.name` to the subclass name via `new.target`
 * so that stack traces identify the concrete error type rather than
 * generic `Error`.
 */
export abstract class TransactionError extends Error {
  /**
   * Stable machine-readable error code. Part of the public contract —
   * callers may rely on it for error handling; changes are breaking.
   */
  abstract readonly code: string;

  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown when the current async context's transactional state does not
 * satisfy the requested `PropagationMode`. Examples: `NEVER` invoked
 * inside an active transaction; `MANDATORY` invoked outside of one; an
 * adapter that does not support savepoints asked to run `NESTED`.
 */
export class IllegalTransactionStateError extends TransactionError {
  readonly code = 'ILLEGAL_TRANSACTION_STATE';
}

/**
 * Thrown when `TransactionManager.run` is asked to use an adapter
 * (identified by type name + instance name) that was never registered
 * with the core `AdapterRegistry`.
 *
 * The message lists both identifiers and points at the likely missing
 * module registration so the fix is obvious from the stack trace.
 */
export class TransactionAdapterNotFoundError extends TransactionError {
  readonly code = 'TRANSACTION_ADAPTER_NOT_FOUND';

  readonly adapterName: string;
  readonly instanceName: string;

  constructor(adapterName: string, instanceName: string) {
    super(
      `Transaction adapter not found: ${adapterName}:${instanceName}. ` +
        `Did you register it via the corresponding transactional module ` +
        `(e.g. TypeOrmTransactionalModule.forFeature())?`,
    );
    this.adapterName = adapterName;
    this.instanceName = instanceName;
  }
}

/**
 * Thrown when an outbox producer fails to persist an event inside a
 * transaction. Wrapping the underlying error lets callers distinguish
 * outbox-write failures from business-logic errors when deciding on
 * retry policy.
 */
export class OutboxWriteError extends TransactionError {
  readonly code = 'OUTBOX_WRITE_ERROR';
}
