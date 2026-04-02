/**
 * Domain event owned by the `inventory` module. Registered with the
 * inventory-DS `OutboxModule.forFeature([ReservationPlacedEvent], { dataSource: 'inventory' })`
 * — Phase 14.3.1 Category A scanner routes any
 * `@OutboxEventsHandler` for this event to the inventory listener
 * registry automatically.
 */
export class ReservationPlacedEvent {
  constructor(
    public readonly reservationId: string,
    public readonly sku: string,
    public readonly quantity: number,
  ) {}
}
