import { Externalized } from '@nestjs-transactional/outbox';

/** Goes to the outbox, then to `@OnOutboxMessage('orders.placed')`. */
@Externalized<OrderPlaced>({ target: 'orders.placed', client: 'local' })
export class OrderPlaced {
  constructor(
    readonly orderId: string,
    readonly sku: string,
  ) {}
}

@Externalized<OrderShipped>({ target: 'orders.shipped', client: 'local' })
export class OrderShipped {
  constructor(
    readonly orderId: string,
    readonly trackingNumber: string,
  ) {}
}
