import { Column, Entity, PrimaryColumn } from 'typeorm';

export type OrderStatus = 'placed' | 'paid' | 'delivered' | 'cancelled';

@Entity({ name: 'orders' })
export class OrderEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  sku!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'int' })
  amountCents!: number;

  @Column({ type: 'text' })
  status!: OrderStatus;

  @Column({ type: 'text', nullable: true })
  chargeId!: string | null;

  @Column({ type: 'text', nullable: true })
  carrier!: string | null;
}
