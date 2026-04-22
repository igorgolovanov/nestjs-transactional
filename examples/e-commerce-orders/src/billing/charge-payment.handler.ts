import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { QueryFailedError, Repository } from 'typeorm';

import {
  PaymentChargedEvent,
  PaymentFailedEvent,
  StockReservedEvent,
} from '../shared/events';
import { PaymentRow } from './payment.entity';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Billing step. Subscribes to `StockReservedEvent` (owned by
 * inventory DS); needs to write to **billing DS**.
 *
 * **Why the inner-method pattern.** A naive
 * `@Transactional({ dataSource: 'billing' })` decoration on the
 * top-level `handle()` method does NOT take effect: the cqrs
 * `IntegrationEventsHandlerScanner` runs in `OnModuleInit` and
 * captures `instance.handle.bind(instance)` BEFORE
 * `TransactionalMethodsBootstrap` (`OnApplicationBootstrap`) gets
 * a chance to wrap the method. The captured reference is the
 * un-wrapped original.
 *
 * The workaround: `handle()` (un-wrapped, called by the worker)
 * delegates to a private method that IS wrapped. Method-call
 * indirection resolves `this.processInBillingTx` at call time —
 * by then bootstrap has installed the wrapped version on the
 * instance, so the billing-DS transaction opens correctly.
 *
 * Single-DS scenarios (e.g. `saga-pattern`) sidestep this because
 * the worker's outer `REQUIRES_NEW` tx is on the default DS, which
 * coincides with the listener's target DS. Cross-DS handlers like
 * this one need the inner-method indirection.
 */
@Injectable()
@IntegrationEventsHandler({ events: [StockReservedEvent], id: 'Billing.ChargePayment' })
export class ChargePaymentHandler implements IIntegrationEventHandler<StockReservedEvent> {
  private readonly logger = new Logger(ChargePaymentHandler.name);

  /** Toy authorisation rule. Amounts at or above this fail. */
  static readonly UNAUTHORISED_AMOUNT_CENTS = 1_000_000;

  constructor(
    @InjectRepository(PaymentRow, 'billing')
    private readonly payments: Repository<PaymentRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  async handle(event: StockReservedEvent): Promise<void> {
    await this.processInBillingTx(event);
  }

  @Transactional({ dataSource: 'billing' })
  private async processInBillingTx(event: StockReservedEvent): Promise<void> {
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
        new PaymentFailedEvent(
          event.orderId,
          event.totalAmountCents,
          'authorisation-declined',
        ),
      );
      return;
    }

    await this.outbox.publish(
      new PaymentChargedEvent(event.orderId, event.totalAmountCents),
    );
  }
}
