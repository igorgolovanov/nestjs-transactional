import { Externalized } from '@nestjs-transactional/outbox';

/**
 * Published by the `Order` aggregate when an order is placed. One event,
 * two durable consumers, both written in the command's transaction:
 *
 * - `@Externalized` adds it to `@nestjs/outbox` under topic
 *   `orders.placed`, routed to the in-process `local` transport, where
 *   `AnalyticsProjection` handles it;
 * - `@StartOn` on `FulfilOrder` starts the fulfilment workflow from it,
 *   through `WorkflowsCqrsModule`.
 */
@Externalized<OrderPlaced>({ target: 'orders.placed', client: 'local' })
export class OrderPlaced {
  constructor(
    readonly orderId: string,
    readonly sku: string,
    readonly quantity: number,
    readonly amountCents: number,
  ) {}
}

/** Published by the workflow's `mark-paid` step, in that step's transaction. */
@Externalized<OrderPaid>({ target: 'orders.paid', client: 'local' })
export class OrderPaid {
  constructor(
    readonly orderId: string,
    readonly chargeId: string,
  ) {}
}
