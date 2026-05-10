import { Externalized } from '@nestjs-transactional/outbox';

import { KAFKA_CLIENT } from '../clients';

/**
 * Cross-context events. Each event is **owned** by the bounded
 * context that publishes it (registered to that context's DataSource
 * via `OutboxModule.forFeature`). Subscribers in other contexts
 * import the class only to type their handlers.
 *
 * The Phase 14.3.1 Category A scanner walks every per-DS
 * `EventTypeRegistry`, finds which DS owns each handler's events,
 * and registers the listener with that DS's listener registry. The
 * `id: 'Module.action'` convention on `@IntegrationEventsHandler`
 * keeps publication-row `listener_id` columns stable across class
 * renames.
 *
 * Routing reminder: a handler reading an Orders-DS-owned event runs
 * inside the orders worker; if it then opens
 * `@Transactional({ dataSource: 'inventory' })`, the framework
 * tracks per-DS `AsyncLocalStorage` so the inventory transaction
 * does NOT inherit anything from the orders worker context (DD-023).
 */

/** Owner: orders DS. Triggers reservation in inventory. */
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly customerId: string,
    readonly items: readonly { sku: string; quantity: number; unitPriceCents: number }[],
    readonly totalAmountCents: number,
  ) {}
}

/** Owner: inventory DS. Triggers payment in billing. */
export class StockReservedEvent {
  constructor(
    readonly orderId: string,
    readonly customerId: string,
    readonly totalAmountCents: number,
  ) {}
}

/** Owner: inventory DS. Triggers compensation in orders. */
export class StockReservationFailedEvent {
  constructor(
    readonly orderId: string,
    readonly reason: string,
    /** Empty when the reservation aborted before reserving anything. */
    readonly reservedSkus: readonly string[],
  ) {}
}

/** Owner: billing DS. Triggers shipment confirmation in orders. */
export class PaymentChargedEvent {
  constructor(
    readonly orderId: string,
    readonly amountCents: number,
  ) {}
}

/** Owner: billing DS. Triggers compensation in orders + inventory. */
export class PaymentFailedEvent {
  constructor(
    readonly orderId: string,
    readonly amountCents: number,
    readonly reason: string,
  ) {}
}

/**
 * Owner: orders DS. **Externalized** to Kafka — leaves the system.
 * Downstream services (notifications, analytics, fulfilment)
 * subscribe via Kafka, NOT via outbox handlers in this app.
 *
 * `@Externalized` decoration ties the publication of this event
 * class to the externalizer pipeline. The `target` is a Kafka topic
 * name; `routingKey` becomes the Kafka message key (kafkajs uses it
 * for partition affinity); `headers` are kafka headers.
 */
@Externalized<OrderConfirmedEvent>({
  target: 'orders.confirmed',
  client: KAFKA_CLIENT,
  routingKey: (event) => event.orderId,
  headers: (event) => ({
    'x-event-type': 'OrderConfirmedEvent',
    'x-order-id': event.orderId,
    'x-customer-id': event.customerId,
  }),
})
export class OrderConfirmedEvent {
  constructor(
    readonly orderId: string,
    readonly customerId: string,
    readonly totalAmountCents: number,
  ) {}
}
