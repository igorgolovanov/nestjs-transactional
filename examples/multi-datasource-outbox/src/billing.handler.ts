import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { InvoiceCreatedEvent } from './events';

/**
 * Phase 14.3.1 Category A — `OutboxListenerScanner` walks every
 * per-DS `EventTypeRegistry` and routes this handler to the registry
 * whose dataSource owns `InvoiceCreatedEvent`. No `dataSource`
 * decorator option needed; the event registration in
 * `OutboxModule.forFeature([InvoiceCreatedEvent])` (default DS) is
 * authoritative.
 *
 * Worker (`EventPublicationProcessor` for the billing DS) polls the
 * billing-DB `event_publication` table, deserialises the event, and
 * invokes `handle()` inside a fresh `REQUIRES_NEW` transaction.
 */
@Injectable()
@OutboxEventsHandler({ events: [InvoiceCreatedEvent], id: 'BillingProjections.invoiceCreated' })
export class BillingProjectionsHandler implements IOutboxEventHandler<InvoiceCreatedEvent> {
  private readonly logger = new Logger(BillingProjectionsHandler.name);

  readonly handled: InvoiceCreatedEvent[] = [];

  async handle(event: InvoiceCreatedEvent): Promise<void> {
    this.logger.log(`Billing projection — invoice ${event.invoiceId} for ${event.customer}`);
    this.handled.push(event);
  }
}
