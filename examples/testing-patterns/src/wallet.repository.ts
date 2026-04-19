import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WalletRow } from './wallet.entity';

/**
 * Domain-owned repository contract. Tests substitute a Jest mock or
 * a hand-rolled in-memory implementation under this token; the
 * integration tier wires the real {@link TypeOrmWalletRepository}.
 */
export interface WalletRepository {
  findById(id: string): Promise<{ id: string; balance: number } | null>;
  updateBalance(id: string, balance: number): Promise<void>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

/**
 * Production implementation. `@InjectRepository(WalletRow)` resolves
 * to the default DataSource's TypeORM `Repository<WalletRow>`. The
 * Phase 14.20 prototype patches make `this.wallets.update(...)` join
 * the ambient `@Transactional` scope automatically.
 */
@Injectable()
export class TypeOrmWalletRepository implements WalletRepository {
  constructor(
    @InjectRepository(WalletRow)
    private readonly wallets: Repository<WalletRow>,
  ) {}

  async findById(id: string): Promise<{ id: string; balance: number } | null> {
    return this.wallets.findOneBy({ id });
  }

  async updateBalance(id: string, balance: number): Promise<void> {
    await this.wallets.update(id, { balance });
  }
}
