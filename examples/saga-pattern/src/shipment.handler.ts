import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { OrderRow } from './entities';
import { OrderShippedEvent, PaymentChargedEvent } from './events';

/**
 * Terminal saga step. Subscribes to `PaymentChargedEvent`. The
 * happy-path branch ends here: the order moves to `'shipped'`.
 *
 * Idempotency comes from the conditional `UPDATE` (`status = 'reserved'`).
 * A retried delivery finds the order already in `'shipped'` and
 * affects zero rows — natural no-op without needing an explicit
 * unique constraint.
 *
 * Publishes `OrderShippedEvent` mostly for observability; nothing
 * else in this saga consumes it. A real system might fan out to a
 * notifications module here.
 */
@Injectable()
@IntegrationEventsHandler({ events: [PaymentChargedEvent], id: 'Saga.Shipment' })
export class ShipmentHandler implements IIntegrationEventHandler<PaymentChargedEvent> {
  private readonly logger = new Logger(ShipmentHandler.name);

  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async handle(event: PaymentChargedEvent): Promise<void> {
    const update = await this.orders.update(
      { id: event.orderId, status: 'reserved' },
      { status: 'shipped' },
    );

    if (update.affected === 0) {
      this.logger.log(`Order ${event.orderId} not in 'reserved' — idempotent skip`);
      return;
    }

    await this.outbox.publish(new OrderShippedEvent(event.orderId));
  }
}
