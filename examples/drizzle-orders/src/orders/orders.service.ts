import { Inject, Injectable } from '@nestjs/common';
import { WorkflowClient } from '@nestjs/workflows';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { eq } from 'drizzle-orm';

import { type Database, DB } from '../database/database.module.js';
import { orders } from '../database/schema.js';
import { ShipOrder, shippingId } from '../shipping/ship-order.workflow.js';

import { OrderPlaced } from './events.js';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly outbox: OutboxEventPublisher,
    private readonly workflows: WorkflowClient,
  ) {}

  /**
   * Three writes, one transaction, and no transaction anywhere in the
   * code: the order through the injected Drizzle db, the outbox message,
   * and the workflow instance. If anything below throws, none of them
   * exists afterwards.
   */
  @Transactional()
  async place(
    orderId: string,
    sku: string,
    amountCents: number,
    failAfterWriting = false,
  ): Promise<void> {
    await this.db.insert(orders).values({ id: orderId, sku, amountCents, status: 'placed' });
    await this.outbox.publish(new OrderPlaced(orderId, sku));
    await this.workflows.start(ShipOrder, { orderId }, { id: shippingId(orderId) });

    if (failAfterWriting) {
      throw new Error(`Order ${orderId} failed after writing; everything rolls back`);
    }
  }

  async find(orderId: string): Promise<{ id: string; status: string } | undefined> {
    return this.db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  }
}
