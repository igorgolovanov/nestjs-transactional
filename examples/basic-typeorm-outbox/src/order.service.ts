import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { OrderEntity } from './order.entity.js';
import { OrderPlacedEvent } from './order-placed.event.js';

/**
 * The atomicity demo. Inside `@Transactional()` we:
 *
 *   1. INSERT into `orders` via the transparent repository
 *      (`@InjectRepository(OrderEntity)`).
 *   2. Add an outbox message through `OutboxEventPublisher.publish`,
 *      which hands `@nestjs/outbox` the transaction `@Transactional`
 *      opened.
 *
 * Both writes commit together or roll back together, and nothing passes
 * the transaction by hand.
 */
@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orders: Repository<OrderEntity>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async placeOrder(orderId: string, customerEmail: string, totalCents: number): Promise<void> {
    await this.orders.save({ id: orderId, customerEmail, totalCents });
    await this.outbox.publish(new OrderPlacedEvent(orderId, customerEmail, totalCents));
  }

  @Transactional()
  async placeOrderAndFail(
    orderId: string,
    customerEmail: string,
    totalCents: number,
  ): Promise<void> {
    await this.orders.save({ id: orderId, customerEmail, totalCents });
    await this.outbox.publish(new OrderPlacedEvent(orderId, customerEmail, totalCents));
    throw new Error('simulated failure after publish — both rows should roll back');
  }

  async listAll(): Promise<OrderEntity[]> {
    return this.orders.find();
  }
}
