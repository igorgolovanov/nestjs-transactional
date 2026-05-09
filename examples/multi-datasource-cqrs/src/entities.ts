import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Persisted row for the billing-DS `Invoice` aggregate. */
@Entity({ name: 'invoices' })
export class InvoiceRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  customer!: string;

  @Column({ type: 'integer' })
  amountCents!: number;
}

/** Persisted row for the inventory-DS `Reservation` aggregate. */
@Entity({ name: 'reservations' })
export class ReservationRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'integer' })
  quantity!: number;
}
