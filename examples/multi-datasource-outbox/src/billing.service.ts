import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { InvoiceEntity } from './entities';
import { InvoiceCreatedEvent } from './events';

/**
 * Operates on the `billing` DataSource (default). The smart
 * `OutboxEventPublisher` facade (DD-024) — injected via class-token
 * DI — auto-resolves the event's owning DS from the per-DS
 * `EventTypeRegistry` and routes the publication into that DS's
 * outbox. Same physical transaction as the `invoices` INSERT.
 *
 * NOTE: do NOT use `@InjectOutboxPublisher(...)` here — that decorator
 * binds the underlying per-DS `DataSourceOutboxPublisher` and bypasses
 * smart-facade routing. Class-token DI is the canonical form for
 * services that publish events potentially routed across DSes.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(InvoiceEntity)
    private readonly invoices: Repository<InvoiceEntity>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async createInvoice(id: string, customer: string, amountCents: number): Promise<void> {
    await this.invoices.save({ id, customer, amountCents });
    await this.outbox.publish(new InvoiceCreatedEvent(id, customer, amountCents));
  }

  @Transactional()
  async createInvoiceAndFail(id: string, customer: string, amountCents: number): Promise<void> {
    await this.invoices.save({ id, customer, amountCents });
    await this.outbox.publish(new InvoiceCreatedEvent(id, customer, amountCents));
    throw new Error('simulated billing failure — both rows roll back');
  }
}
