import { AggregateRoot } from '@nestjs/cqrs';

export class InvoiceIssuedEvent {
  constructor(
    public readonly invoiceId: string,
    public readonly customer: string,
    public readonly amountCents: number,
  ) {}
}

/**
 * Billing-side aggregate. Lives on the default DataSource. Phase
 * 14.3.1 Category B routes the dispatcher hook for AFTER_COMMIT
 * delivery onto the *default* dataSource's active transaction.
 */
export class Invoice extends AggregateRoot {
  constructor(
    public readonly id: string,
    public readonly customer: string,
    public readonly amountCents: number,
  ) {
    super();
  }

  issue(): void {
    this.apply(new InvoiceIssuedEvent(this.id, this.customer, this.amountCents));
  }
}
