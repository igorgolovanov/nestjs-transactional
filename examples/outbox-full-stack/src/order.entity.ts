import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Business table — the row whose existence we want to commit
 * atomically with the OrderPlacedEvent publication.
 */
@Entity({ name: 'orders' })
export class OrderRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  status!: string;
}
