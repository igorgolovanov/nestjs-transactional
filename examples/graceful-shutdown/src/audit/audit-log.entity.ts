import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Trivial audit-log row. The example's domain is intentionally
 * uninteresting — the focus is shutdown semantics, not domain logic.
 */
@Entity({ name: 'audit_log' })
export class AuditLogEntry {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;
}
