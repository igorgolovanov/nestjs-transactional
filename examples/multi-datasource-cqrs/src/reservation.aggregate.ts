import { AggregateRoot } from '@nestjs/cqrs';

export class ReservationPlacedEvent {
  constructor(
    public readonly reservationId: string,
    public readonly sku: string,
    public readonly quantity: number,
  ) {}
}

/**
 * Inventory-side aggregate. Lives on the `inventory` DataSource.
 * Phase 14.3.1 Category B routes the dispatcher hook for
 * AFTER_COMMIT delivery onto the *inventory* dataSource's active
 * transaction (not the default's) — the bound listener below carries
 * `dataSource: 'inventory'` for that purpose.
 */
export class Reservation extends AggregateRoot {
  constructor(
    public readonly id: string,
    public readonly sku: string,
    public readonly quantity: number,
  ) {
    super();
  }

  place(): void {
    this.apply(new ReservationPlacedEvent(this.id, this.sku, this.quantity));
  }
}
