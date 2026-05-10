import { NotFoundException } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { OrderResponseDto } from '../shared/dtos';
import { OrderRow } from './order.entity';

export class GetOrderQuery {
  constructor(readonly orderId: string) {}
}

/**
 * Read-side query handler. CQRS purity is light here on purpose:
 * the example reads the same `OrderRow` table that writes target,
 * not a separate denormalized projection. That keeps the example's
 * data flow at one diagram. A production app might split a
 * `OrderProjectionRow` table updated from `@TransactionalEventsHandler`
 * AFTER_COMMIT projections — see `cqrs-full-stack` for that style.
 *
 * `CqrsTransactionalModule` auto-wraps query handlers as readonly
 * (Convention #14 carry-over); the actual lookup runs autocommit
 * on the orders DS.
 */
@QueryHandler(GetOrderQuery)
export class GetOrderHandler implements IQueryHandler<GetOrderQuery, OrderResponseDto> {
  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
  ) {}

  async execute(query: GetOrderQuery): Promise<OrderResponseDto> {
    const row = await this.orders.findOneBy({ id: query.orderId });
    if (!row) {
      throw new NotFoundException(`order ${query.orderId} not found`);
    }
    return {
      id: row.id,
      customerId: row.customerId,
      status: row.status,
      totalAmountCents: row.totalAmountCents,
      items: row.items,
      placedAt: row.placedAt.toISOString(),
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      failureReason: row.failureReason,
    };
  }
}
