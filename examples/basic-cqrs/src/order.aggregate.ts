import { AggregateRoot } from '@nestjs/cqrs';

export class OrderPlacedEvent {
  constructor(public readonly orderId: string) {}
}

/**
 * Minimal aggregate. `apply()` records an event in the internal buffer;
 * `commit()` (called by the command handler) flushes the buffered
 * events through the `EventPublisher` — `@nestjs-transactional/cqrs`
 * overrides that publisher so events become AFTER_COMMIT hooks on the
 * active transaction instead of being dispatched immediately.
 */
export class Order extends AggregateRoot {
  constructor(public readonly id: string) {
    super();
  }

  place(): void {
    this.apply(new OrderPlacedEvent(this.id));
  }
}
