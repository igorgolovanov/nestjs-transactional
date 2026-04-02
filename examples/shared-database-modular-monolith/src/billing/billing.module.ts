import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@nestjs-transactional/outbox';

import { BillingPaymentProjectionListener } from './billing.listener';
import { BillingService } from './billing.service';
import { InvoicePaidEvent } from './invoice-paid.event';
import { InvoiceRow } from './invoice.entity';

/**
 * `BillingModule` encapsulates the billing bounded-context — its
 * entity feature registration, event registration, service, and
 * outbox listener. Modulith-style: domain-private code stays here.
 *
 * Process-wide infrastructure (the `TransactionalModule` singleton +
 * per-DS outbox stacks) is centralised in `AppModule` for
 * deterministic init order: NestJS instantiates sibling modules'
 * providers in import-list order, so cross-module event-type
 * registrations need to land before any per-module
 * `OutboxListenerScanner` walks the providers. Putting `forRoot` at
 * the AppModule level guarantees all registries are populated before
 * the scanner fires.
 *
 * The billing module is bound to the framework's *default* DataSource
 * (DI name `'default'`); physically that DS lives in the Postgres
 * `billing` schema (`TypeOrmModule.forRoot({ schema: 'billing' })`
 * in `AppModule`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([InvoiceRow]),
    OutboxModule.forFeature([InvoicePaidEvent]),
  ],
  providers: [BillingService, BillingPaymentProjectionListener],
  exports: [BillingService],
})
export class BillingModule {}
