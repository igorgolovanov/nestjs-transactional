import { Injectable } from '@nestjs/common';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { Order } from './order.aggregate';
import { OrderRow } from './order.entity';

@Injectable()
export class OrderRepository {
  constructor(private readonly ds: DataSource) {}

  async save(order: Order): Promise<void> {
    const em = getCurrentEntityManager('default', this.ds);
    await em.save(OrderRow, { id: order.id, status: order.status });
  }

  async findById(id: string): Promise<OrderRow | null> {
    return this.ds.manager.findOne(OrderRow, { where: { id } });
  }

  async listAll(): Promise<OrderRow[]> {
    return this.ds.manager.find(OrderRow);
  }
}
