import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { StockItemEntity } from './entities';
import { StockAdjustedEvent } from './events';

/**
 * Operates on the `inventory` DataSource. The smart
 * `OutboxEventPublisher` facade — injected via class-token DI —
 * resolves `StockAdjustedEvent` to the inventory DS via the per-DS
 * `EventTypeRegistry` (populated by
 * `OutboxModule.forFeature([StockAdjustedEvent], { dataSource: 'inventory' })`)
 * and writes the publication row into the inventory DS's outbox.
 * Atomic with the `stock_items` INSERT.
 */
@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(StockItemEntity, 'inventory')
    private readonly stock: Repository<StockItemEntity>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional({ dataSource: 'inventory' })
  async adjustStock(sku: string, newQuantity: number): Promise<void> {
    await this.stock.save({ sku, quantity: newQuantity });
    await this.outbox.publish(new StockAdjustedEvent(sku, newQuantity));
  }

  @Transactional({ dataSource: 'inventory' })
  async adjustStockAndFail(sku: string, newQuantity: number): Promise<void> {
    await this.stock.save({ sku, quantity: newQuantity });
    await this.outbox.publish(new StockAdjustedEvent(sku, newQuantity));
    throw new Error('simulated inventory failure — both rows roll back');
  }
}
