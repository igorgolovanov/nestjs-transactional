import { Injectable, Logger } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { PaymentFailedEvent, StockReservationFailedEvent } from '../shared/events.js';
import { OrderRow } from './order.entity.js';

/**
 * Saga compensation. Subscribes to BOTH failure events and walks
 * the order to its `'failed'` terminal state with the appropriate
 * `failureReason`.
 *
 * **Two events, one handler.** Both branches do the same conditional
 * UPDATE. The compensation in inventory (releasing reserved stock
 * on `PaymentFailedEvent`) is owned by `inventory/release-stock.handler.ts`
 * — a different bounded context with its own handler and inbox.
 * Choreography keeps the contexts decoupled.
 *
 * Idempotency: conditional `UPDATE WHERE status = 'placed'`. A
 * retry finds the order already failed and zero-affects.
 */
@Injectable()
export class OrdersCompensationHandler {
  private readonly logger = new Logger(OrdersCompensationHandler.name);

  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
  ) {}

  @OnOutboxMessage(['StockReservationFailedEvent', 'PaymentFailedEvent'], {
    consumer: 'orders.compensation',
  })
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
