import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { Repository } from 'typeorm';

import {
  PaymentFailedEvent,
  StockReservationFailedEvent,
} from '../shared/events';
import { OrderRow } from './order.entity';

/**
 * Saga compensation. Subscribes to BOTH failure events and walks
 * the order to its `'failed'` terminal state with the appropriate
 * `failureReason`.
 *
 * **Two events, one handler.** Both branches do the same conditional
 * UPDATE. The compensation in inventory (releasing reserved stock
 * on `PaymentFailedEvent`) is owned by `inventory/release-stock.handler.ts`
 * — different bounded context, different DS, different worker.
 * Choreography keeps the contexts decoupled.
 *
 * Idempotency: conditional `UPDATE WHERE status = 'placed'`. A
 * retry finds the order already failed and zero-affects.
 */
@Injectable()
@IntegrationEventsHandler({
  events: [StockReservationFailedEvent, PaymentFailedEvent],
  id: 'Orders.Compensation',
})
export class OrdersCompensationHandler
  implements IIntegrationEventHandler<StockReservationFailedEvent | PaymentFailedEvent>
{
  private readonly logger = new Logger(OrdersCompensationHandler.name);

  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
  ) {}

  @Transactional()
  async handle(event: StockReservationFailedEvent | PaymentFailedEvent): Promise<void> {
    const update = await this.orders.update(
      { id: event.orderId, status: 'placed' },
      { status: 'failed', failureReason: event.reason },
    );

    if (update.affected === 0) {
      this.logger.log(`Order ${event.orderId} not in 'placed' — compensation no-op`);
    }
  }
}
