/**
 * Domain event published from `BillingService.createInvoice`. Registered
 * with `OutboxModule.forFeature([InvoiceCreatedEvent])` (default DS) —
 * the per-DS `EventTypeRegistry` used by the outbox listener scanner to
 * resolve which outbox owns this event.
 */
export class InvoiceCreatedEvent {
  constructor(
    public readonly invoiceId: string,
    public readonly customer: string,
    public readonly amountCents: number,
  ) {}
}

/**
 * Domain event published from `InventoryService.adjustStock`. Registered
 * with `OutboxModule.forFeature([StockAdjustedEvent], { dataSource: 'inventory' })`
 * — the inventory DS's outbox owns it; the outbox listener scanner routes
 * `@OutboxEventsHandler` listeners for this event to the inventory
 * registry automatically.
 */
export class StockAdjustedEvent {
  constructor(
    public readonly sku: string,
    public readonly newQuantity: number,
  ) {}
}
