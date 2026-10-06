import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { eq } from 'drizzle-orm';

import { type Database, DB } from '../database/database.module.js';
import { orders } from '../database/schema.js';
import { OrderShipped } from '../orders/events.js';

@Injectable()
export class ShippingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  /** A stand-in for a courier API: the same order always gets the same number. */
  async bookCourier(orderId: string): Promise<string> {
    return `trk-${orderId}`;
  }

  /** Called from a workflow step; the status and `orders.shipped` commit together. */
  @Transactional()
  async markShipped(orderId: string, trackingNumber: string): Promise<void> {
    await this.db.update(orders).set({ status: 'shipped' }).where(eq(orders.id, orderId));
    await this.outbox.publish(new OrderShipped(orderId, trackingNumber));
  }
}
