import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Lives in the `billing` DataSource (default). Records customer
 * invoices.
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
 * Lives in the `inventory` DataSource. Records on-hand stock per SKU.
 */
@Entity({ name: 'stock_items' })
export class StockItemEntity {
  @PrimaryColumn({ type: 'text' })
  sku!: string;

  @Column({ type: 'integer' })
  quantity!: number;
}
