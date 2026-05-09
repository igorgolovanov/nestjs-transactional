import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Lives in the **billing** Postgres database (default DataSource).
 * The `event_publication` table for billing events also lives here —
 * single-unit atomicity (DD-019) commits the invoice row and the
 * publication row in one transaction.
 */
@Entity({ name: 'invoices' })
export class InvoiceEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  customer!: string;

  @Column({ type: 'integer' })
  amountCents!: number;
}

/**
 * Lives in the **inventory** Postgres database (named `'inventory'`
 * DataSource). Same atomicity contract on its side, fully independent
 * from billing's transaction (DD-023).
 */
@Entity({ name: 'reservations' })
export class ReservationEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'integer' })
  quantity!: number;
}
