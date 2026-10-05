import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { OrderEntity } from './order.entity.js';
import { OrderPlacedEvent } from './order-placed.event.js';

/**
 * Atomicity extended to a broker:
 *
 *   1. INSERT into `orders` via the transparent repository.
 *   2. Add an outbox message through `OutboxEventPublisher.publish`.
 *
 * Both writes commit together. After the commit `@nestjs/outbox`'s relay
 * emits the message to Kafka. If the broker rejects it, the message stays
 * in the outbox and is retried with backoff, and after the last attempt
 * it is dead-lettered with its error history. A rollback leaves no
 * message, so nothing ever reaches Kafka for an order that does not
 * exist.
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
    throw new Error('simulated failure — both the order and its outbox message roll back');
  }

  async listAll(): Promise<OrderEntity[]> {
    return this.orders.find();
  }
}
