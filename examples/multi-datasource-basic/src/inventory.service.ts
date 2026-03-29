import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { StockItemEntity } from './entities';

/**
 * Operates on the `inventory` DataSource — registered under that
 * dataSource name. Methods declare `@Transactional({ dataSource: 'inventory' })`
 * (DD-020 canonical form) so the manager opens the transaction
 * against the inventory adapter, not the default.
 *
 * `@InjectRepository(StockItemEntity, 'inventory')` resolves the
 * Repository bound to the inventory DataSource — `@nestjs/typeorm`
 * derives the per-DS provider token automatically.
 */
@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(StockItemEntity, 'inventory')
    private readonly stock: Repository<StockItemEntity>,
  ) {}

  @Transactional({ dataSource: 'inventory' })
  async upsertStock(sku: string, quantity: number): Promise<StockItemEntity> {
    return this.stock.save({ sku, quantity });
  }

  @Transactional({ dataSource: 'inventory' })
  async upsertStockAndFail(sku: string, quantity: number): Promise<void> {
    await this.stock.save({ sku, quantity });
    throw new Error('simulated inventory failure — should roll back');
  }

  async listAll(): Promise<StockItemEntity[]> {
    return this.stock.find();
  }
}
