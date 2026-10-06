import { Injectable } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';

import type { OrderPlaced, OrderShipped } from '../orders/events.js';

/**
 * Receives the outbox messages through `@nestjs/outbox`'s relay, after
 * the transaction that added them has committed.
 */
@Injectable()
export class NotificationsHandler {
  readonly sent: string[] = [];

  @OnOutboxMessage('orders.placed', { consumer: 'notifications.orders-placed' })
  async onPlaced(event: OrderPlaced): Promise<void> {
    this.sent.push(`order ${event.orderId} received`);
  }

  @OnOutboxMessage('orders.shipped', { consumer: 'notifications.orders-shipped' })
  async onShipped(event: OrderShipped): Promise<void> {
    this.sent.push(`order ${event.orderId} shipped, tracking ${event.trackingNumber}`);
  }
}
