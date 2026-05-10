import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { OrderRow } from './entities';
import { OrderPlacedEvent } from './events';

/**
 * Saga entry point. `placeOrder` opens a transaction, persists the
 * order row in `placed` status, and publishes `OrderPlacedEvent` —
 * all atomically (DD-019). The reservation handler picks the event
 * up via the outbox.
 *
 * `OutboxEventPublisher.publish` is the canonical class-token
 * injection (Phase 14.8c carry-over) and routes by the event class's
 * `OutboxModule.forFeature` registration. This example registers
 * everything in one `'default'` dataSource so all events route the
 * same way.
 */
@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async placeOrder(
    orderId: string,
    sku: string,
    quantity: number,
    amount: number,
  ): Promise<void> {
    await this.orders.insert({
      id: orderId,
      sku,
      quantity,
      amount,
      status: 'placed',
    });
    await this.outbox.publish(new OrderPlacedEvent(orderId, sku, quantity, amount));
  }
}
