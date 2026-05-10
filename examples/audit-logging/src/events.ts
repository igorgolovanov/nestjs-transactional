/**
 * Domain event published by `AccountService` whenever an account
 * mutates. Carries enough payload that the audit consumer never has
 * to read back the business DS — auditing across DataSources should
 * not introduce a read dependency on the source of record (otherwise
 * stale-read anomalies leak into the audit trail).
 *
 * `operationId` is the natural idempotency key. The audit handler
 * uses it as the primary key of `AuditLogRow` so the outbox's
 * at-least-once retries surface as a `unique_violation` and the
 * handler can skip them without double-logging.
 */
export class AccountOperationEvent {
  constructor(
    /** Unique per business operation. Doubles as the audit row's PK. */
    readonly operationId: string,
    readonly accountId: string,
    readonly type: 'deposit' | 'withdraw',
    readonly amount: number,
    /** Balance AFTER the operation. Audit log records the post-state. */
    readonly balanceAfter: number,
  ) {}
}
