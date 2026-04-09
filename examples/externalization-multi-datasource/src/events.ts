import { Externalized } from '@nestjs-transactional/outbox';

import { BILLING_BROKER, INVENTORY_BROKER } from './clients';

/**
 * Published from `BillingService.payInvoice`. Persisted to the
 * billing DS's `event_publication` table (Phase 14.3.2 per-DS outbox
 * stack); externalized to RabbitMQ via the BILLING_BROKER client to
 * the `billing.events` queue.
 *
 * The two axes — which DS owns the publication row, which broker
 * receives the event — are orthogonal. Here they line up by
 * convention: billing DS → BILLING_BROKER queue.
 */
@Externalized<InvoicePaidEvent>({
  target: 'billing.events',
  client: BILLING_BROKER,
  headers: (event) => ({
    'x-event-type': 'InvoicePaidEvent',
    'x-correlation-id': event.invoiceId,
  }),
})
export class InvoicePaidEvent {
  constructor(
    public readonly invoiceId: string,
    public readonly customer: string,
    public readonly amountCents: number,
  ) {}
}

/**
 * Published from `InventoryService.placeReservation`. Persisted to
 * the inventory DS's `event_publication` table; externalized to
 * RabbitMQ via the INVENTORY_BROKER client to the `inventory.events`
 * queue.
 */
@Externalized<ReservationPlacedEvent>({
  target: 'inventory.events',
  client: INVENTORY_BROKER,
  headers: (event) => ({
    'x-event-type': 'ReservationPlacedEvent',
    'x-correlation-id': event.reservationId,
  }),
})
export class ReservationPlacedEvent {
  constructor(
    public readonly reservationId: string,
    public readonly sku: string,
    public readonly quantity: number,
  ) {}
}
