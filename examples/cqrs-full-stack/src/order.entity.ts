import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'orders' })
export class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  status!: string;
}
