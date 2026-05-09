import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Lives in the `billing` Postgres schema. Same physical database as
 * `inventory.reservations`, but in a different namespace — TypeORM
 * resolves `INSERT INTO invoices` to `billing.invoices` because the
 * billing DataSource is configured with `schema: 'billing'`.
 */
@Entity({ name: 'invoices' })
export class InvoiceRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  customer!: string;

  @Column({ type: 'integer' })
  amountCents!: number;
}
