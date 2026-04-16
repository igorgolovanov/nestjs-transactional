import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Order aggregate row. `status` walks the saga state machine:
 *
 *   `placed` → `shipped`                  (happy path)
 *   `placed` → `failed-reservation`       (step 1 compensation terminal)
 *   `placed` → `reserved` → `failed-payment`
 *                                         (step 2 compensation terminal,
 *                                          stock released by compensation)
 *
 * The intermediate `reserved` status is set by the reservation
 * handler so the compensation handler can tell, on
 * `PaymentFailedEvent`, whether stock was actually decremented and
 * needs releasing (it always is, by the time payment runs).
 */
@Entity({ name: 'orders' })
export class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'int' })
  amount!: number;

  @Column({ type: 'text' })
  status!: string;
}

/**
 * Reservation row. `orderId` is the primary key — duplicate delivery
 * of `OrderPlacedEvent` (outbox at-least-once) tries a second
 * `INSERT` with the same key and Postgres rejects it. The handler
 * catches that as the idempotency signal and skips the rest of the
 * step (see `reservation.handler.ts`).
 */
@Entity({ name: 'reservations' })
export class ReservationRow {
  @PrimaryColumn({ type: 'text' })
  orderId!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'int' })
  quantity!: number;
}

/**
 * Payment row. Same idempotency idea as `ReservationRow` — `orderId`
 * is the primary key and a duplicate INSERT signals "this step
 * already ran."
 */
@Entity({ name: 'payments' })
export class PaymentRow {
  @PrimaryColumn({ type: 'text' })
  orderId!: string;

  @Column({ type: 'int' })
  amount!: number;

  /** `'charged'` or `'failed'`. Set inside the same transaction as the publication. */
  @Column({ type: 'text' })
  status!: string;
}

/** Stock-on-hand row. Decremented in step 1; restored on payment-failure compensation. */
@Entity({ name: 'stock_items' })
export class StockItemRow {
  @PrimaryColumn({ type: 'text' })
  sku!: string;

  @Column({ type: 'int' })
  available!: number;
}
