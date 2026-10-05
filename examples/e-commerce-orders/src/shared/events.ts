import { Externalized } from '@nestjs-transactional/outbox';

import { KAFKA_CLIENT } from '../clients.js';

/**
 * Cross-context events. Each is published by the bounded context that
 * owns it, inside that context's transaction, and delivered by
 * `@nestjs/outbox` to the `@OnOutboxMessage` handlers of the next step.
 *
 * Events published with `OutboxEventPublisher.publish()` go to a topic
 * named after their class. The two that leave an aggregate through
 * `aggregate.commit()` carry `@Externalized`, because that is how the
 * bridge knows to take an aggregate's event into the outbox: the rest
 * of an aggregate's events stay with the in-memory dispatcher.
 *
 * Handlers receive plain JSON, not instances of these classes; the
 * classes type the payload.
 */

/**
 * Owner: orders. Starts the saga: inventory reserves stock.
 *
 * Applied by the `Order` aggregate, so it reaches the outbox through
 * `aggregate.commit()`. `client: 'local'` routes it to `@nestjs/outbox`'s
 * in-process transport, where `ReserveStockHandler` subscribes to
 * `orders.placed`.
 */
@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
  client: 'local',
  routingKey: (event) => event.orderId,
})
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly customerId: string,
    readonly items: readonly { sku: string; quantity: number; unitPriceCents: number }[],
    readonly totalAmountCents: number,
  ) {}
}

/** Owner: inventory. Triggers payment in billing. */
export class StockReservedEvent {
  constructor(
    readonly orderId: string,
    readonly customerId: string,
    readonly totalAmountCents: number,
  ) {}
}

/** Owner: inventory. Triggers compensation in orders. */
export class StockReservationFailedEvent {
  constructor(
    readonly orderId: string,
    readonly reason: string,
    /** Empty when the reservation aborted before reserving anything. */
    readonly reservedSkus: readonly string[],
  ) {}
}

/** Owner: billing. Triggers shipment confirmation in orders. */
export class PaymentChargedEvent {
  constructor(
    readonly orderId: string,
    readonly amountCents: number,
  ) {}
}

/** Owner: billing. Triggers compensation in orders + inventory. */
export class PaymentFailedEvent {
  constructor(
    readonly orderId: string,
    readonly amountCents: number,
    readonly reason: string,
  ) {}
}

/**
 * Owner: orders. **Externalized** to Kafka — leaves the system.
 * Downstream services (notifications, analytics, fulfilment)
 * subscribe via Kafka, NOT via outbox handlers in this app.
 *
 * The `target` is the Kafka topic; with `toKafkaPacket`, `routingKey`
 * becomes the Kafka message key (partition affinity) and `headers`
 * become Kafka headers. The value is the outbox envelope.
 */
@Externalized<OrderConfirmedEvent>({
  target: 'orders.confirmed',
  client: KAFKA_CLIENT,
  routingKey: (event) => event.orderId,
  headers: (event) => ({
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
