import { Injectable, Logger } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { Repository } from 'typeorm';

import { PaymentChargedEvent } from '../shared/events';
import { Order } from './order.aggregate';
import { OrderRow } from './order.entity';

/**
 * Final happy-path step. `PaymentChargedEvent` was published by the
 * billing context's outbox; the orders worker (this DS owns no
 * publication for this event, but the cross-package
 * `OUTBOX_LISTENER_REGISTRAR` registrar resolves the owning DS via
 * the per-DS `EventTypeRegistry` — Phase 14.3.1 Cat A) delivers it.
 *
 * The handler:
 *   1. Loads the persisted `OrderRow`, hydrates an `Order` aggregate.
 *   2. Calls `aggregate.confirm()` — apply pushes
 *      `OrderConfirmedEvent` onto the queue.
 *   3. Updates the row to `confirmed` status and stamps
 *      `confirmedAt`.
 *   4. `aggregate.commit()` — `OrderConfirmedEvent` flows through
 *      `HybridEventPublisher`. The class carries `@Externalized`
 *      metadata so the outbox row is, on processor delivery,
 *      forwarded to the Kafka `ClientProxy`.
 *
 * Idempotency: gated on `status = 'placed'` in the conditional
 * UPDATE. A retried delivery finds the order already `confirmed`,
 * the UPDATE affects zero rows, the handler returns. No duplicate
 * `OrderConfirmedEvent` reaches Kafka.
 */
@Injectable()
@IntegrationEventsHandler({ events: [PaymentChargedEvent], id: 'Orders.ConfirmShipment' })
export class ConfirmShipmentHandler implements IIntegrationEventHandler<PaymentChargedEvent> {
  private readonly logger = new Logger(ConfirmShipmentHandler.name);

  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
    private readonly publisher: EventPublisher,
  ) {}

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
