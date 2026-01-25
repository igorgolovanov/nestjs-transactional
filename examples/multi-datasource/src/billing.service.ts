import { Inject, Injectable } from '@nestjs/common';
import { TransactionalOn } from '@nestjs-transactional/core';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { InvoiceEntity } from './entities';

export const BILLING_DS = Symbol('BILLING_DS');

@Injectable()
export class BillingService {
  constructor(@Inject(BILLING_DS) private readonly billing: DataSource) {}

  // Equivalent to @Transactional({ adapterInstance: 'billing' }).
  // Routes to the 'billing' adapter registered under the
  // `typeorm:billing` context key.
  @TransactionalOn('billing')
  async generateInvoice(id: string, orderId: string, amountCents: number): Promise<void> {
    const em = getCurrentEntityManager('billing', this.billing);
    await em.save(InvoiceEntity, { id, orderId, amountCents });
  }

  async listAll(): Promise<InvoiceEntity[]> {
    return this.billing.manager.find(InvoiceEntity);
  }
}
