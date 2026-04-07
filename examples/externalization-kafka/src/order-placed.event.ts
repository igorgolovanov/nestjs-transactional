import { Externalized } from '@nestjs-transactional/outbox';

/**
 * Domain event published from `OrderService.placeOrder`. Two roles:
 *
 *   1. **Local outbox listener** — `ShippingHandler` is registered
 *      via `@OutboxEventsHandler({ events: [OrderPlacedEvent] })`.
 *      The worker invokes it AFTER_COMMIT in a fresh transaction.
 *   2. **External broker delivery** — `@Externalized({ target: ... })`
 *      tells `EventPublicationProcessor` to also call the bound
 *      `EventExternalizer` (here `MicroservicesEventExternalizer`)
 *      after the local handler succeeds (DD-019 single-unit
 *      atomicity, local-first ordering).
 *
 * `routingKey` derives a Kafka message key from the event so
 * messages for the same order land on the same partition (preserves
 * per-key ordering on the consumer side). `headers` injects an
 * application-level header for tracing.
 */
@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
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
