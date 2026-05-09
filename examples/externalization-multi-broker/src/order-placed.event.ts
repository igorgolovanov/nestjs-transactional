import { Externalized } from '@nestjs-transactional/outbox';

import { KAFKA_CLIENT } from './clients';

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
    'x-event-type': 'OrderPlacedEvent',
    'x-customer': event.customerEmail,
  }),
})
export class OrderPlacedEvent {
  constructor(
    public readonly orderId: string,
    public readonly customerEmail: string,
    public readonly totalCents: number,
  ) {}
}
