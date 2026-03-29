import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { InvoiceEntity } from './entities';

/**
 * Operates on the `billing` DataSource — registered as the default
 * adapter (`isDefault: true`), so `@Transactional()` without an
 * explicit `dataSource` option routes here.
 *
 * `@InjectRepository(InvoiceEntity)` resolves the Repository bound
 * to the default DataSource. Phase 14.20 patches dispatch through
 * the active `@Transactional()` scope — no manual EntityManager
 * lookup.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(InvoiceEntity)
    private readonly invoices: Repository<InvoiceEntity>,
  ) {}

  @Transactional()
  async createInvoice(id: string, customer: string, amountCents: number): Promise<InvoiceEntity> {
    return this.invoices.save({ id, customer, amountCents });
  }

  @Transactional()
  async createInvoiceAndFail(
    id: string,
    customer: string,
    amountCents: number,
  ): Promise<void> {
    await this.invoices.save({ id, customer, amountCents });
    throw new Error('simulated billing failure — should roll back');
  }

  async listAll(): Promise<InvoiceEntity[]> {
    return this.invoices.find();
  }
}
