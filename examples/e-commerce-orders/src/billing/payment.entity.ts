import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Payment ledger. PK on `orderId` so the duplicate-INSERT idempotency
 * gate (Tier 4 saga-pattern carry-over) works for billing too.
 */
@Entity({ name: 'payments' })
export class PaymentRow {
  @PrimaryColumn({ type: 'text' })
  orderId!: string;

  @Column({ type: 'int' })
  amountCents!: number;

  @Column({ type: 'text' })
  status!: 'charged' | 'failed';

  @Column({ type: 'timestamptz' })
  recordedAt!: Date;
}
