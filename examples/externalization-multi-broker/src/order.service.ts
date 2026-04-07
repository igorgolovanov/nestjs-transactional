import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { CacheInvalidationEvent } from './cache-invalidation.event';
import { OrderEntity } from './order.entity';
import { OrderPlacedEvent } from './order-placed.event';
import { RefundRequestedEvent } from './refund-requested.event';

/**
 * Demonstrates that a single `@Transactional` method can publish
 * multiple events that each route to DIFFERENT brokers. The outbox
 * packs all three publications into the single business transaction
 * (DD-019 single-unit atomicity); the worker dispatches them one by
 * one and the externalizer picks the right `ClientProxy` for each
 * via `metadata.client`.
 *
 * `placeOrder` writes the order, then publishes:
 *   - `OrderPlacedEvent`        → Kafka  (KAFKA_CLIENT)
 *   - `RefundRequestedEvent`    → RabbitMQ (RABBITMQ_CLIENT) — only
 *     when the optional `refundReason` parameter is set, simulating
 *     a refund created in the same business operation.
 *   - `CacheInvalidationEvent`  → Redis pub/sub (REDIS_CLIENT) —
 *     unconditionally, to drop any cached pricing for this customer.
 *
 * On rollback NONE of the brokers receives anything (atomic gate).
 *
 * `OutboxEventPublisher` is injected by class token (smart facade,
 * DD-024) — the canonical default. The `@InjectOutboxPublisher`
 * decorator binds the per-DS underlying publisher and bypasses
 * smart-facade routing.
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
      throw new Error('simulated failure — all three publications + the order roll back together');
    }
  }

  async listAll(): Promise<OrderEntity[]> {
    return this.orders.find();
  }
}
