import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Business-DS account row. The system of record for balance. */
@Entity({ name: 'accounts' })
export class AccountRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'int' })
  balance!: number;
}

/**
 * Business-DS operation log. Persisting the operation row in the
 * SAME transaction as the balance update is what makes the
 * `AccountOperationEvent` payload trustworthy — by the time the
 * outbox worker delivers the event, the operation row exists and
 * its fields match the event payload (DD-019 single-unit atomicity).
 */
@Entity({ name: 'account_operations' })
export class AccountOperationRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  accountId!: string;

  @Column({ type: 'text' })
  type!: 'deposit' | 'withdraw';

  @Column({ type: 'int' })
  amount!: number;

  @Column({ type: 'int' })
  balanceAfter!: number;

  @Column({ type: 'timestamptz' })
  occurredAt!: Date;
}

/**
 * Audit-DS row. `operationId` is the primary key — duplicate
 * delivery from outbox at-least-once retries surfaces as
 * `unique_violation` and the handler treats that as the idempotency
 * gate.
 *
 * Schema deliberately mirrors `AccountOperationRow` payload-wise so
 * an auditor can ask "what was the post-balance recorded for this
 * operation?" without joining back to the business DB. The audit DB
 * is independent: a business-DB restore-from-backup does not erase
 * the audit trail, and an audit-DB outage does not block business
 * operations (the outbox just queues until the audit DB is back).
 */
@Entity({ name: 'audit_log' })
export class AuditLogRow {
  @PrimaryColumn({ type: 'text' })
  operationId!: string;

  @Column({ type: 'text' })
  accountId!: string;

  @Column({ type: 'text' })
  type!: 'deposit' | 'withdraw';

  @Column({ type: 'int' })
  amount!: number;

  @Column({ type: 'int' })
  balanceAfter!: number;

  @Column({ type: 'timestamptz' })
  recordedAt!: Date;
}
