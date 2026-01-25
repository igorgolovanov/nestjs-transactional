import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { OrderEntity } from './entities';

export const PRIMARY_DS = Symbol('PRIMARY_DS');

@Injectable()
export class OrderService {
  constructor(@Inject(PRIMARY_DS) private readonly primary: DataSource) {}

  // No adapterInstance → defaults to 'default', which is our primary adapter.
  @Transactional()
  async placeOrder(id: string, customer: string): Promise<void> {
    const em = getCurrentEntityManager('default', this.primary);
    await em.save(OrderEntity, { id, customer });
  }

  async listAll(): Promise<OrderEntity[]> {
    return this.primary.manager.find(OrderEntity);
  }
}
