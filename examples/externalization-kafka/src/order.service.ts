import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { OrderEntity } from './order.entity';
import { OrderPlacedEvent } from './order-placed.event';

/**
 * Single-unit atomicity (DD-019) extended to externalization:
 *
 *   1. INSERT into `orders` via the Phase 14.20 transparent repository.
 *   2. APPEND a publication row through `OutboxEventPublisher.publish`.
 *
 * Both writes commit together. The `EventPublicationProcessor` worker
 * then picks the row up, invokes the local `@OutboxEventsHandler`
 * (`ShippingHandler`), and finally calls the externalizer to emit
 * the event onto Kafka. If the LOCAL listener succeeds but the
 * externalizer throws, the publication stays `FAILED` and is retried
 * on the next poll — see `EventPublicationProcessor.processOne`.
 *
 * Note on DI: `OutboxEventPublisher` is injected via class token —
 * NOT via `@InjectOutboxPublisher(...)`. The class-token form gives
 * the smart facade (DD-024) which is the canonical default. The
 * decorator form binds the per-DS underlying publisher and is only
 * needed for advanced multi-DS routing scenarios.
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
    throw new Error('simulated failure — both orders row and publication row roll back');
  }

  async listAll(): Promise<OrderEntity[]> {
    return this.orders.find();
  }
}
