import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'orders' })
export class OrderEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  customerEmail!: string;

  @Column({ type: 'integer' })
  totalCents!: number;
}
