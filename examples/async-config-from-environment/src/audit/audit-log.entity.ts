import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Trivial audit-log row. The example's domain is intentionally
 * uninteresting — the point is the *configuration* shape, not the
 * domain logic. A real app would write its own business rows here
 * exactly the same way.
 */
@Entity({ name: 'audit_log' })
export class AuditLogEntry {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;
}
