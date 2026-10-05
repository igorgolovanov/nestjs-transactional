import { Injectable, Logger } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { QueryFailedError, Repository } from 'typeorm';

import { PaymentChargedEvent, PaymentFailedEvent, StockReservedEvent } from '../shared/events.js';
import { PaymentRow } from './payment.entity.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Billing step. Subscribes to `StockReservedEvent`, published by the
 * inventory context; writes the payment in the `billing` schema and
 * publishes the outcome in the same transaction.
 *
 * `@Transactional()` sits directly on the `@OnOutboxMessage` method:
 * `@nestjs/outbox` looks the method up on the instance at delivery time,
 * so it calls the transactional version that bootstrap installed.
 *
 * Idempotency: the payment's primary key is the order id, so a
 * redelivery that got past the inbox surfaces as `unique_violation` and
 * is skipped.
 */
@Injectable()
export class ChargePaymentHandler {
  private readonly logger = new Logger(ChargePaymentHandler.name);

  /** Toy authorisation rule. Amounts at or above this fail. */
  static readonly UNAUTHORISED_AMOUNT_CENTS = 1_000_000;

  constructor(
    @InjectRepository(PaymentRow)
    private readonly payments: Repository<PaymentRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @OnOutboxMessage('StockReservedEvent', { consumer: 'billing.charge-payment' })
  @Transactional()
  async handle(event: StockReservedEvent): Promise<void> {
    const willFail = event.totalAmountCents >= ChargePaymentHandler.UNAUTHORISED_AMOUNT_CENTS;
    const status = willFail ? 'failed' : 'charged';

    try {
      await this.payments.insert({
        orderId: event.orderId,
        amountCents: event.totalAmountCents,
        status,
        recordedAt: new Date(),
      });
    } catch (err) {
      if (
        err instanceof QueryFailedError &&
        (err.driverError as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION
      ) {
        this.logger.log(`Payment for ${event.orderId} already recorded — idempotent skip`);
        return;
      }
      throw err;
    }

    if (willFail) {
      this.logger.warn(`Payment failed for ${event.orderId} — emitting failure`);
      await this.outbox.publish(
        new PaymentFailedEvent(event.orderId, event.totalAmountCents, 'authorisation-declined'),
      );
      return;
    }

    await this.outbox.publish(new PaymentChargedEvent(event.orderId, event.totalAmountCents));
  }
}
