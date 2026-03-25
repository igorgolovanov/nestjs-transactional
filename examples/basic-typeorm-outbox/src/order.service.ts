import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { InjectOutboxPublisher, OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { OrderEntity } from './order.entity';
import { OrderPlacedEvent } from './order-placed.event';

/**
 * The single-unit atomicity demo (DD-019). Inside `@Transactional()`
 * we:
 *
 *   1. INSERT into `orders` via the Phase 14.20 transparent repository
 *      (`@InjectRepository(OrderEntity)`).
 *   2. Append a publication row through `OutboxEventPublisher.publish`
 *      — `TypeOrmEventPublicationRepository` writes to
 *      `event_publication` through the same active EntityManager.
 *
 * Both writes commit together (SAME database transaction) or roll back
 * together. Phase 14.21's atomicity invariant — pinned by the
 * integration test — applies verbatim to this example.
 */
@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orders: Repository<OrderEntity>,
    @InjectOutboxPublisher()
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
