import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { RefundRequestedEvent } from './refund-requested.event.js';
import { RefundEntity } from './refund.entity.js';

/**
 * Producer side. The refund row and its outbox message commit together.
 * Every failure scenario in this example happens after this method
 * returns: the broker is not contacted until the relay picks the message
 * up, so nothing about delivery can be inferred from this commit.
 */
@Injectable()
export class RefundService {
  constructor(
    @InjectRepository(RefundEntity)
    private readonly refunds: Repository<RefundEntity>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async requestRefund(refundId: string, orderId: string, amountCents: number): Promise<void> {
    await this.refunds.save({ id: refundId, orderId, amountCents });
    await this.outbox.publish(new RefundRequestedEvent(refundId, orderId, amountCents));
  }

  async listAll(): Promise<RefundEntity[]> {
    return this.refunds.find();
  }
}
