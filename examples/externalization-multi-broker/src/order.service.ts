import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { CacheInvalidationEvent } from './cache-invalidation.event.js';
import { OrderPlacedEvent } from './order-placed.event.js';
import { OrderEntity } from './order.entity.js';
import { RefundRequestedEvent } from './refund-requested.event.js';

/**
 * Demonstrates that a single `@Transactional` method can publish
 * multiple events that each route to a DIFFERENT broker. All three
 * outbox messages commit with the order in one transaction; afterwards
 * `@nestjs/outbox`'s relay delivers each through the transport its
 * `@Externalized({ client })` names, and a broker that fails holds back
 * only its own message.
 *
 * `placeOrder` writes the order, then publishes:
 *   - `OrderPlacedEvent`        → Kafka  (KAFKA_CLIENT)
 *   - `RefundRequestedEvent`    → RabbitMQ (RABBITMQ_CLIENT), only
 *     when `refundCents` is given, simulating a refund created in the
 *     same business operation.
 *   - `CacheInvalidationEvent`  → Redis pub/sub (REDIS_CLIENT),
 *     unconditionally, to drop any cached pricing for this customer.
 *
 * On rollback none of the brokers receives anything.
 */
@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orders: Repository<OrderEntity>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async placeOrder(
    orderId: string,
    customerEmail: string,
    totalCents: number,
    options?: { readonly refundCents?: number; readonly fail?: boolean },
  ): Promise<void> {
    await this.orders.save({ id: orderId, customerEmail, totalCents });

    await this.outbox.publish(new OrderPlacedEvent(orderId, customerEmail, totalCents));

    if (options?.refundCents !== undefined) {
      await this.outbox.publish(
        new RefundRequestedEvent(`refund-${orderId}`, orderId, options.refundCents),
      );
    }

    await this.outbox.publish(
      new CacheInvalidationEvent(`customer:${customerEmail}:pricing`, `order ${orderId} placed`),
    );

    if (options?.fail === true) {
      throw new Error('simulated failure — the order and all three messages roll back together');
    }
  }

  async listAll(): Promise<OrderEntity[]> {
    return this.orders.find();
  }
}
