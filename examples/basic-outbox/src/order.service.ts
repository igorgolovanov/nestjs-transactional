import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { InjectOutboxPublisher, OutboxEventPublisher } from '@nestjs-transactional/outbox';

import { OrderPlacedEvent } from './order-placed.event';

@Injectable()
export class OrderService {
  constructor(
    @InjectOutboxPublisher()
    private readonly outbox: OutboxEventPublisher,
  ) {}

  /**
   * Publishing inside a `@Transactional()` method buffers the event in
   * the active transaction and flushes it on commit. If the method
   * throws, the buffered event is discarded — the publication row is
   * never written. Single-unit atomicity (DD-019).
   */
  @Transactional()
  async placeOrder(orderId: string, customerEmail: string): Promise<void> {
    // In a real app this would also write an `Order` row to the DB.
    // basic-outbox keeps the focus on the publish path; basic-typeorm-outbox
    // demonstrates the row + publication committed in the same transaction.
    await this.outbox.publish(new OrderPlacedEvent(orderId, customerEmail));
  }

  @Transactional()
  async placeOrderAndFail(orderId: string, customerEmail: string): Promise<void> {
    await this.outbox.publish(new OrderPlacedEvent(orderId, customerEmail));
    throw new Error('simulated failure after publish — should roll back');
  }
}
