import { Injectable, Logger } from '@nestjs/common';
import {
  type ITransactionalEventHandler,
  TransactionalEventsHandler,
} from '@nestjs-transactional/cqrs';

import { InvoiceIssuedEvent } from './invoice.aggregate';

/**
 * Listens to `InvoiceIssuedEvent` on the **default** dataSource. No
 * `dataSource` decorator option needed — `'default'` is the implicit
 * default. `TransactionalEventDispatcher` attaches the AFTER_COMMIT
 * hook to the default DS's active transaction. If the publishing
 * transaction rolls back, this handler is skipped.
 */
@Injectable()
@TransactionalEventsHandler(InvoiceIssuedEvent)
export class BillingNotificationListener
  implements ITransactionalEventHandler<InvoiceIssuedEvent>
{
  private readonly logger = new Logger(BillingNotificationListener.name);

  readonly notified: string[] = [];

  handle(event: InvoiceIssuedEvent): void {
    this.notified.push(event.invoiceId);
    this.logger.log(`AFTER_COMMIT (billing) — notifying for invoice ${event.invoiceId}`);
  }
}
