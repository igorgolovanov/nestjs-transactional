import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Orders aggregate row. `status` walks the saga state machine:
 *
 *   `placed`     → published; awaiting reservation
 *   `confirmed`  → terminal happy path; OrderConfirmedEvent emitted
 *   `failed`     → terminal compensation; failureReason populated
 *
 * `items` is JSONB — the example does not split into a child table
 * to keep the schema minimal. A real app likely models lines as a
 * separate table for query flexibility.
 */
@Entity({ name: 'orders' })
export class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  customerId!: string;

  @Column({ type: 'text' })
  status!: 'placed' | 'confirmed' | 'failed';

  @Column({ type: 'int' })
  totalAmountCents!: number;

  @Column({ type: 'jsonb' })
  items!: { sku: string; quantity: number; unitPriceCents: number }[];

  @Column({ type: 'timestamptz' })
  placedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;
}
