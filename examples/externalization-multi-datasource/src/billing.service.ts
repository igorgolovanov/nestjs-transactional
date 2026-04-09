import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { InvoiceEntity } from './entities';
import { InvoicePaidEvent } from './events';

/**
 * Bound to the **default** DataSource (the billing DB). The `@Transactional`
 * scope without an explicit `dataSource` argument resolves to default,
 * which means:
 *
 *   - INSERT into the billing `invoices` table
 *   - APPEND a row to the billing `event_publication` table
 *
 * commit together. The outbox worker on the billing DS picks the row
 * up; the externalizer routes it to RabbitMQ via BILLING_BROKER.
 *
 * `OutboxEventPublisher` is the smart-facade form (DD-024). Class-token
 * DI lets the facade inspect the active per-DS transaction context
 * and dispatch to the right per-DS publisher. Single-DS examples
 * don't notice the difference; multi-DS examples like this one MUST
 * use the class-token form (the @InjectOutboxPublisher decorator
 * binds the per-DS publisher and bypasses the facade — using it in
 * a multi-DS service silently sends every event to the default DS's
 * publication table, regardless of the active transaction's DS).
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(InvoiceEntity)
    private readonly invoices: Repository<InvoiceEntity>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async payInvoice(
    invoiceId: string,
    customer: string,
    amountCents: number,
    fail = false,
  ): Promise<void> {
    await this.invoices.save({ id: invoiceId, customer, amountCents });
    await this.outbox.publish(new InvoicePaidEvent(invoiceId, customer, amountCents));
    if (fail) throw new Error('billing rollback');
  }

  async listAll(): Promise<InvoiceEntity[]> {
    return this.invoices.find();
  }
}
