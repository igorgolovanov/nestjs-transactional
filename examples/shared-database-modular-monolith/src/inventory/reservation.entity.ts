import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Lives in the `inventory` Postgres schema. Same physical database
 * as `billing.invoices`, but in a different namespace —
 * `inventory.reservations` is fully isolated from billing's tables.
 */
@Entity({ name: 'reservations' })
export class ReservationRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'integer' })
  quantity!: number;
}
