import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  type IIntegrationEventHandler,
} from '@nestjs-transactional/cqrs';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { QueryFailedError, Repository } from 'typeorm';

import { PaymentRow } from './entities';
import {
  InventoryReservedEvent,
  PaymentChargedEvent,
  PaymentFailedEvent,
} from './events';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Saga step 2. Subscribes to `InventoryReservedEvent`.
 *
 * Decides charge / fail using a deterministic toy rule: amounts at
 * or above a threshold (`UNAUTHORISED_AMOUNT`) "fail authorisation."
 * In a real system this would call out to a payment gateway; the
 * saga shape (write outcome row + publish outcome event atomically)
 * is unchanged either way.
 *
 * Idempotency: `PaymentRow.orderId` is the primary key. A duplicate
 * `INSERT` from a retried delivery surfaces as `unique_violation` —
 * we treat that as "this step already ran" and return without
 * re-publishing. Without this guard, the outbox's at-least-once
 * delivery could double-charge.
 */
@Injectable()
@IntegrationEventsHandler({ events: [InventoryReservedEvent], id: 'Saga.Payment' })
export class PaymentHandler implements IIntegrationEventHandler<InventoryReservedEvent> {
  private readonly logger = new Logger(PaymentHandler.name);

  /** Toy authorisation rule. Amounts at or above this fail. */
  static readonly UNAUTHORISED_AMOUNT = 10_000;

  constructor(
    @InjectRepository(PaymentRow)
    private readonly payments: Repository<PaymentRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async handle(event: InventoryReservedEvent): Promise<void> {
    const willFail = event.amount >= PaymentHandler.UNAUTHORISED_AMOUNT;
    const status = willFail ? 'failed' : 'charged';

    try {
      await this.payments.insert({
        orderId: event.orderId,
        amount: event.amount,
        status,
      });
    } catch (err) {
      if (err instanceof QueryFailedError && (err.driverError as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
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
          event.sku,
          event.quantity,
          'authorisation-declined',
        ),
      );
      return;
    }

    await this.outbox.publish(new PaymentChargedEvent(event.orderId, event.amount));
  }
}
