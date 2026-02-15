import { AggregateRoot } from '@nestjs/cqrs';

/** Domain event emitted when an order transitions to 'placed'. */
export class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

/**
 * Aggregate root. `apply()` stages events on the aggregate;
 * `commit()` (called inside the command handler) routes them through
 * the EventPublisher that CqrsTransactionalModule wired — in this
 * example, through HybridEventPublisher, which in turn dispatches to
 * both the in-memory dispatcher AND the outbox.
 */
export class Order extends AggregateRoot {
  status = 'pending';

  constructor(readonly id: string) {
    super();
  }

  place(): void {
    this.status = 'placed';
    this.apply(new OrderPlacedEvent(this.id));
  }
}
