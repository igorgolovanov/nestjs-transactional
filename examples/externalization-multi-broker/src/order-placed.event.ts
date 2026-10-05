import { Externalized } from '@nestjs-transactional/outbox';

import { KAFKA_CLIENT } from './clients.js';

/**
 * Domain event routed to **Kafka** — partitioned, durable, ordered.
 * The `routingKey` callback derives the Kafka message key so all
 * messages for the same order land on the same partition.
 *
 * Kafka semantics fit this event because order processing typically
 * needs per-key ordering on the consumer side and the volume can be
 * high enough to need partitioning.
 */
@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
  client: KAFKA_CLIENT,
  routingKey: (event) => event.orderId,
  headers: (event) => ({
    'x-customer': event.customerEmail,
  }),
})
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly customerEmail: string,
    readonly totalCents: number,
  ) {}
}
