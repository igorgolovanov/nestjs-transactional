import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Lives in the `billing` DataSource (default). Its `event_publication`
 * table — owned by the `outbox-typeorm` registration for the same DS —
 * lives in the same Postgres database, so an INSERT into `invoices`
 * and the matching publication row commit together.
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
 * Lives in the `inventory` DataSource — a separate Postgres database.
 * Its own `event_publication` table is independent of the billing
 * one; events from this DS never leak into the billing outbox.
 */
@Entity({ name: 'stock_items' })
export class StockItemEntity {
  @PrimaryColumn({ type: 'text' })
  sku!: string;

  @Column({ type: 'integer' })
  quantity!: number;
}
