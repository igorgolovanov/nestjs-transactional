import { Injectable, Logger } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { OnOutboxMessage } from '@nestjs/outbox';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { PaymentChargedEvent } from '../shared/events.js';

import { Order } from './order.aggregate.js';
import { OrderRow } from './order.entity.js';

/**
 * Final happy-path step. `PaymentChargedEvent` was published by the
 * billing context, and `@nestjs/outbox`'s relay delivers it here.
 *
 * The handler:
 *   1. Loads the persisted `OrderRow`, hydrates an `Order` aggregate.
 *   2. Calls `aggregate.confirm()` — apply pushes
 *      `OrderConfirmedEvent` onto the queue.
 *   3. Updates the row to `confirmed` status and stamps
 *      `confirmedAt`.
 *   4. `aggregate.commit()` — `OrderConfirmedEvent` goes through the
 *      `EventBus`. The class carries `@Externalized`, so
 *      it becomes an outbox message in this transaction, and the
 *      relay forwards it to Kafka after the commit.
 *
 * Idempotency: gated on `status = 'placed'` in the conditional
 * UPDATE. A retried delivery finds the order already `confirmed`,
 * the UPDATE affects zero rows, the handler returns. No duplicate
 * `OrderConfirmedEvent` reaches Kafka.
 */
@Injectable()
export class ConfirmShipmentHandler {
  private readonly logger = new Logger(ConfirmShipmentHandler.name);

  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
    private readonly publisher: EventPublisher,
  ) {}

  @OnOutboxMessage('PaymentChargedEvent', { consumer: 'orders.confirm-shipment' })
  @Transactional()
  async handle(event: PaymentChargedEvent): Promise<void> {
    const row = await this.orders.findOneBy({ id: event.orderId });
    if (!row) {
      this.logger.warn(`Order ${event.orderId} not found — dropping`);
      return;
    }

    const update = await this.orders.update(
      { id: event.orderId, status: 'placed' },
      { status: 'confirmed', confirmedAt: new Date() },
    );

    if (update.affected === 0) {
      this.logger.log(`Order ${event.orderId} not in 'placed' — idempotent skip`);
      return;
    }

    const order = this.publisher.mergeObjectContext(
      new Order(row.id, row.customerId, row.items, row.totalAmountCents),
    );
    order.confirm();
    order.commit();
  }
}
