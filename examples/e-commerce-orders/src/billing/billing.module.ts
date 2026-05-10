import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@nestjs-transactional/outbox';

import {
  PaymentChargedEvent,
  PaymentFailedEvent,
} from '../shared/events';
import { ChargePaymentHandler } from './charge-payment.handler';
import { PaymentRow } from './payment.entity';

/**
 * Billing bounded context. Owns the billing DataSource entities
 * and publishes both payment-outcome events from this DS.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PaymentRow], 'billing'),
    OutboxModule.forFeature([PaymentChargedEvent, PaymentFailedEvent], {
      dataSource: 'billing',
    }),
  ],
  providers: [ChargePaymentHandler],
})
export class BillingModule {}
