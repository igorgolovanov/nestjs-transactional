/**
 * Domain event owned by the `billing` module. Registered with the
 * billing-DS `OutboxModule.forFeature([InvoicePaidEvent], { dataSource: 'billing' })`
 * — Phase 14.3.1 Category A scanner routes any `@OutboxEventsHandler`
 * for this event to the billing outbox listener registry.
 */
export class InvoicePaidEvent {
  constructor(
    public readonly invoiceId: string,
    public readonly customer: string,
    public readonly amountCents: number,
  ) {}
}
