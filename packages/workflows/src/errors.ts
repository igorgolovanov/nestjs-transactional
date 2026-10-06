import { IllegalTransactionStateError, type IsolationLevel } from '@nestjs-transactional/core';

/**
 * A workflow signal was sent inside a transaction whose isolation level
 * `@nestjs/workflows` cannot signal from. On PostgreSQL its store needs
 * READ COMMITTED for a signal: under a stricter level, the signal's
 * wake-ups could miss waits committed after the transaction's snapshot.
 *
 * Thrown before anything is written, so the transaction is untouched.
 */
export class WorkflowIsolationError extends IllegalTransactionStateError {
  constructor(
    readonly dataSource: string,
    readonly isolation: IsolationLevel,
  ) {
    super(
      `A workflow signal cannot join the transaction on dataSource '${dataSource}': it runs at ` +
        `${isolation}, and @nestjs/workflows needs READ_COMMITTED to signal on PostgreSQL. Send ` +
        'the signal from a READ_COMMITTED transaction, or after this one commits.',
    );
  }
}
