import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'refunds' })
export class RefundEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  orderId!: string;

  @Column({ type: 'integer' })
  amountCents!: number;
}
