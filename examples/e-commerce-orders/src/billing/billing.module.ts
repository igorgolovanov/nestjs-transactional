import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ChargePaymentHandler } from './charge-payment.handler.js';
import { PaymentRow } from './payment.entity.js';

/**
 * Billing bounded context. Owns the tables in the `billing` schema and
 * publishes both payment-outcome events.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PaymentRow])],
  providers: [ChargePaymentHandler],
})
export class BillingModule {}
