import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { RefundEntity } from './refund.entity';
import { RefundRequestedEvent } from './refund-requested.event';

/**
 * Producer side. Single-unit atomicity (DD-019): refund row + event
 * publication row commit together. The worker then picks the
 * publication up and runs local handlers + externalization. Every
 * subsequent failure scenario in this example happens AFTER this
 * method returns successfully — the producer never knows whether
 * the broker actually received anything (ADR-016).
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
