import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { InvoicePaidEvent } from './events';

/**
 * Local listener for the billing DS. The Phase 14.3.1 Category A
 * `OutboxListenerScanner` resolves the owning DS by walking per-DS
 * `EventTypeRegistry` instances — `InvoicePaidEvent` is registered
 * via `OutboxModule.forFeature([...])` (default DS), so this
 * listener auto-routes to the billing DS's
 * `OutboxListenerRegistry`. Runs BEFORE externalization (DD-019
 * ordering); if it throws, RabbitMQ is NEVER emitted.
 */
@Injectable()
@OutboxEventsHandler({ events: [InvoicePaidEvent], id: 'Billing.recordPayment' })
export class BillingPaymentHandler implements IOutboxEventHandler<InvoicePaidEvent> {
  private readonly logger = new Logger(BillingPaymentHandler.name);

  readonly handled: InvoicePaidEvent[] = [];

  async handle(event: InvoicePaidEvent): Promise<void> {
    this.logger.log(`Billing local: recording payment for invoice ${event.invoiceId}`);
    this.handled.push(event);
  }
}
