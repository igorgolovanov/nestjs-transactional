import { Injectable } from '@nestjs/common';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { Order } from './order.aggregate';
import { OrderRow } from './order.entity';

/**
 * Repository reads and writes through `getCurrentEntityManager` so
 * every call joins the ambient `@Transactional()` scope.
 */
@Injectable()
export class OrderRepository {
  constructor(private readonly ds: DataSource) {}

  async save(order: Order): Promise<void> {
    const em = getCurrentEntityManager('default', this.ds);
    await em.save(OrderRow, { id: order.id, status: order.status });
  }

  async listAll(): Promise<OrderRow[]> {
    return this.ds.manager.find(OrderRow);
  }
}
