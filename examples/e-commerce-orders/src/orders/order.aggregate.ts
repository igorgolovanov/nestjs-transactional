import { AggregateRoot } from '@nestjs/cqrs';

import {
  OrderConfirmedEvent,
  OrderPlacedEvent,
} from '../shared/events';

/**
 * Order aggregate. CQRS-style — `apply()` stages events on the
 * aggregate's internal queue; `commit()` (called inside the command
 * handler) routes them through `EventPublisher` (overridden by
 * `CqrsTransactionalModule` to `HybridEventPublisher`), which fans
 * out to BOTH the in-memory dispatcher AND the outbox.
 *
 * Both apply paths (`place`, `confirm`) push exactly one event onto
 * the queue. The handler calls `aggregate.commit()` once per use
 * case.
 */
export class Order extends AggregateRoot {
  status: 'placed' | 'confirmed' | 'failed' = 'placed';
  confirmedAt: Date | null = null;
  failureReason: string | null = null;

  constructor(
    readonly id: string,
    readonly customerId: string,
    readonly items: readonly { sku: string; quantity: number; unitPriceCents: number }[],
    readonly totalAmountCents: number,
  ) {
    super();
  }

  place(): void {
    this.apply(
      new OrderPlacedEvent(
        this.id,
        this.customerId,
        this.items,
        this.totalAmountCents,
      ),
    );
  }

  confirm(): void {
    this.status = 'confirmed';
    this.confirmedAt = new Date();
    this.apply(
      new OrderConfirmedEvent(this.id, this.customerId, this.totalAmountCents),
    );
  }

  fail(reason: string): void {
    this.status = 'failed';
    this.failureReason = reason;
    // No event apply — `failed` is a terminal local state. The
    // compensation handler (or the original failure event) is the
    // signal others care about; re-emitting OrderFailedEvent would
    // duplicate it.
  }
}
