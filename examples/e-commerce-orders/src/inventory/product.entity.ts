import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Stock-on-hand row. Decremented in reservation; restored in compensation. */
@Entity({ name: 'products' })
export class ProductRow {
  @PrimaryColumn({ type: 'text' })
  sku!: string;

  @Column({ type: 'int' })
  available!: number;
}
