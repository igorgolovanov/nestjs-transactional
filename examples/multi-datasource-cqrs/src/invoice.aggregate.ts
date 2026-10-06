import { AggregateRoot } from '@nestjs/cqrs';

export class InvoiceIssuedEvent {
  constructor(
    readonly invoiceId: string,
    readonly customer: string,
    readonly amountCents: number,
  ) {}
}

/**
 * Billing-side aggregate. Lives on the default DataSource. Phase
 * 14.3.1 Category B routes the dispatcher hook for AFTER_COMMIT
 * delivery onto the *default* dataSource's active transaction.
 */
export class Invoice extends AggregateRoot {
  constructor(
    readonly id: string,
    readonly customer: string,
    readonly amountCents: number,
  ) {
    super();
  }

  issue(): void {
    this.apply(new InvoiceIssuedEvent(this.id, this.customer, this.amountCents));
  }
}
