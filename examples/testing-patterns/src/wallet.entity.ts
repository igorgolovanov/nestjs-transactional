import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Tiny aggregate so the testing utilities have something concrete to
 * exercise. The domain is deliberately one-table: the focus of this
 * example is the test scaffolding, not the schema.
 */
@Entity({ name: 'wallets' })
export class WalletRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'int' })
  balance!: number;
}
