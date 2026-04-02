import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { InvoicePaidEvent } from './invoice-paid.event';

/**
 * Module-internal listener — observes the `InvoicePaidEvent` after
 * it lands in `billing.event_publication` and the worker dispatches
 * it. Phase 14.3.1 Category A scanner finds the event in the
 * billing-DS registry and routes this handler to billing's
 * `OutboxListenerRegistry` automatically.
 *
 * In a real Spring Modulith app, this is where module-internal
 * projections / notifications happen. Cross-module integration —
 * e.g. notifying inventory of a payment — would call into the
 * inventory module's transactional API explicitly, NOT inside the
 * same transaction (cross-DS / cross-schema transactions are not
 * supported per DD-023).
 */
@Injectable()
@OutboxEventsHandler({ events: [InvoicePaidEvent], id: 'billing.payment-projection' })
export class BillingPaymentProjectionListener
  implements IOutboxEventHandler<InvoicePaidEvent>
{
  private readonly logger = new Logger(BillingPaymentProjectionListener.name);

  readonly observed: InvoicePaidEvent[] = [];

  async handle(event: InvoicePaidEvent): Promise<void> {
    this.logger.log(
      `billing.payment-projection — invoice ${event.invoiceId} (${event.customer})`,
    );
    this.observed.push(event);
  }
}
