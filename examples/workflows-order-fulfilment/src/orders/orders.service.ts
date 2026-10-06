import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { WorkflowClient } from '@nestjs/workflows';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { delivered } from '../fulfilment/delivered.signal.js';

import { OrderPaid } from './events.js';
import { OrderEntity } from './order.entity.js';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(OrderEntity) private readonly orders: Repository<OrderEntity>,
    private readonly outbox: OutboxEventPublisher,
    private readonly workflows: WorkflowClient,
  ) {}

  /**
   * Called from the workflow's `mark-paid` step. The status update and the
   * `orders.paid` outbox message commit together.
   */
  @Transactional()
  async markPaid(orderId: string, chargeId: string): Promise<void> {
    await this.orders.update({ id: orderId }, { status: 'paid', chargeId });
    await this.outbox.publish(new OrderPaid(orderId, chargeId));
  }

  /** Called from the workflow's compensation once the charge is refunded. */
  @Transactional()
  async cancel(orderId: string): Promise<void> {
    await this.orders.update({ id: orderId }, { status: 'cancelled' });
  }

  /**
   * The carrier's delivery webhook. The status update and the workflow
   * signal commit together: `signal()` gets this transaction from the
   * workflows bridge, with no `transaction` option here. If anything
   * throws, the waiting workflow never hears about it.
   */
  @Transactional()
  async confirmDelivery(orderId: string, carrier: string, failAfterWriting = false): Promise<void> {
    await this.orders.update({ id: orderId }, { status: 'delivered', carrier });
    await this.workflows.signal(delivered, { carrier }, { key: orderId });
    if (failAfterWriting) {
      throw new Error(`Delivery of ${orderId} failed after writing; the signal rolls back`);
    }
  }

  find(orderId: string): Promise<OrderEntity | null> {
    return this.orders.findOneBy({ id: orderId });
  }
}
