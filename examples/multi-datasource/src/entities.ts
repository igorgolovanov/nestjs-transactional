import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'orders' })
export class OrderEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  customer!: string;
}

@Entity({ name: 'invoices' })
export class InvoiceEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  orderId!: string;

  @Column({ type: 'integer' })
  amountCents!: number;
}
