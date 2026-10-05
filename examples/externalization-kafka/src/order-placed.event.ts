import { Externalized } from '@nestjs-transactional/outbox';

/**
 * Domain event published from `OrderService.placeOrder` and delivered to
 * Kafka.
 *
 * The bridge adds it to `@nestjs/outbox` inside the order's transaction,
 * on topic `orders.placed`. After the commit the relay hands it to the
 * Kafka transport, which with `toKafkaPacket` sends:
 *
 *   - the Kafka key `routingKey(event)`, the order id, so one order's
 *     events land on one partition, in commit order;
 *   - the headers below plus `x-event-type` and `x-outbox-id`;
 *   - the envelope `{ id, topic, key, headers, createdAt, payload }` as
 *     the value, where `id` is what a consumer deduplicates on.
 *
 * No `client` is named, so `externalizedRoute`'s `defaultTransport`
 * picks the transport.
 */
@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
  routingKey: (event) => event.orderId,
  headers: (event) => ({ 'x-customer': event.customerEmail }),
})
export class OrderPlacedEvent {
  constructor(
    public readonly orderId: string,
    public readonly customerEmail: string,
    public readonly totalCents: number,
  ) {}
}
