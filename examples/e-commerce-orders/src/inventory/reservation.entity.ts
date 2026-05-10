import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-order reservation row. PK on `orderId` + `sku` is composed
 * inline as a single string `${orderId}:${sku}` — keeps the
 * idempotency check single-column-PK simple. A real schema would
 * use a composite key.
 */
@Entity({ name: 'reservations' })
export class ReservationRow {
  /** `${orderId}:${sku}` — composite key encoded for single-column PK. */
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  orderId!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'int' })
  quantity!: number;

  /** `'reserved'` or `'released'` — released by compensation handler. */
  @Column({ type: 'text' })
  status!: 'reserved' | 'released';
}
