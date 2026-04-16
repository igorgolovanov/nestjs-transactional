/**
 * Saga step events. Each event names what just happened in the
 * preceding step; the next step's `@IntegrationEventsHandler`
 * subscribes to it. Events flow through the outbox — every step
 * commits its business write atomically with the publication of its
 * outcome event (DD-019), and the worker delivers the event to the
 * next step's handler in a fresh transaction.
 *
 * Failure events (`InventoryReservationFailedEvent`,
 * `PaymentFailedEvent`) drive the compensation handler. The
 * compensation handler is a regular `@IntegrationEventsHandler` —
 * compensation in this saga is "another step that runs because a
 * failure event was published," not a separate framework concept.
 */

/** Step 0 → 1 trigger. Order has been accepted; reservation should run next. */
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly sku: string,
    readonly quantity: number,
    readonly amount: number,
  ) {}
}

/** Step 1 success → step 2 trigger. Stock has been decremented atomically with this publication. */
export class InventoryReservedEvent {
  constructor(
    readonly orderId: string,
    readonly sku: string,
    readonly quantity: number,
    readonly amount: number,
  ) {}
}

/** Step 1 failure → compensation trigger. No stock was decremented; nothing to release. */
export class InventoryReservationFailedEvent {
  constructor(
    readonly orderId: string,
    readonly sku: string,
    readonly reason: string,
  ) {}
}

/** Step 2 success → step 3 trigger. Payment has been recorded atomically with this publication. */
export class PaymentChargedEvent {
  constructor(
    readonly orderId: string,
    readonly amount: number,
  ) {}
}

/**
 * Step 2 failure → compensation trigger. Payment has been marked failed
 * atomically with this publication; the previously-reserved stock must
 * be released by the compensation handler.
 */
export class PaymentFailedEvent {
  constructor(
    readonly orderId: string,
    readonly sku: string,
    readonly quantity: number,
    readonly reason: string,
  ) {}
}

/** Terminal success event. Order is shipped; saga ends. Published for observability. */
export class OrderShippedEvent {
  constructor(readonly orderId: string) {}
}
