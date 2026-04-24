import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { OrderRepository } from './order.repository';
import type { OrderRow } from './order.entity';

export class GetOrderQuery {
  constructor(readonly orderId: string) {}
}

@QueryHandler(GetOrderQuery)
export class GetOrderHandler implements IQueryHandler<GetOrderQuery, OrderRow | null> {
  constructor(private readonly repo: OrderRepository) {}

  // Wrapped automatically as a read-only transaction by
  // CqrsTransactionalModule.forRoot's defaultQueryOptions.
  async execute(query: GetOrderQuery): Promise<OrderRow | null> {
    return this.repo.findById(query.orderId);
  }
}
