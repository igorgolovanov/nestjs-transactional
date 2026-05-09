import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { InvoicePaidEvent } from './invoice-paid.event';
import { InvoiceRow } from './invoice.entity';

/**
 * Operates exclusively on the `billing` Postgres schema. The
 * billing module owns the framework's *default* DataSource (DI name
 * `'default'`) — its physical storage is the `billing` schema via
 * `TypeOrmModule.forRoot({ schema: 'billing' })` in `AppModule`.
 *
 * `@Transactional()` (no explicit `dataSource`) opens the transaction
 * on the default adapter; the `OutboxEventPublisher` smart facade
 * resolves `InvoicePaidEvent` to this DS via the per-DS
 * `EventTypeRegistry` and writes the publication row into
 * `billing.event_publication` — same transaction as the
 * `billing.invoices` INSERT (DD-019 single-unit atomicity).
 *
 * NOTE: framework-level "default" + Postgres-level "billing" schema
 * is intentional naming asymmetry. Phase 14.3+ today binds class-token
 * outbox aliases (e.g. `StartupRecoveryService`) to the default DS
 * only; multi-DS deployments make one of their domain modules the
 * default. The README documents this pattern.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(InvoiceRow)
    private readonly invoices: Repository<InvoiceRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async payInvoice(id: string, customer: string, amountCents: number): Promise<void> {
    await this.invoices.save({ id, customer, amountCents });
    await this.outbox.publish(new InvoicePaidEvent(id, customer, amountCents));
  }

  @Transactional()
  async payInvoiceAndFail(id: string, customer: string, amountCents: number): Promise<void> {
    await this.invoices.save({ id, customer, amountCents });
    await this.outbox.publish(new InvoicePaidEvent(id, customer, amountCents));
    throw new Error('billing rollback — invoice + publication discarded');
  }
}
