import { Injectable } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';

import type { OrderPaid, OrderPlaced } from '../orders/events.js';

/**
 * Receives the outbox messages through `@nestjs/outbox`'s relay, after
 * the transactions that wrote them committed. A rolled-back order never
 * reaches it.
 */
@Injectable()
export class AnalyticsProjection {
  readonly seen: string[] = [];

  @OnOutboxMessage('orders.placed', { consumer: 'analytics.orders-placed' })
  async onPlaced(event: OrderPlaced): Promise<void> {
    this.seen.push(`placed ${event.orderId}`);
  }

  @OnOutboxMessage('orders.paid', { consumer: 'analytics.orders-paid' })
  async onPaid(event: OrderPaid): Promise<void> {
    this.seen.push(`paid ${event.orderId}`);
  }
}
