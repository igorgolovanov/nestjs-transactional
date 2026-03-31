import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { InvoiceRow } from './entities';
import { Invoice } from './invoice.aggregate';

export class IssueInvoiceCommand {
  constructor(
    public readonly id: string,
    public readonly customer: string,
    public readonly amountCents: number,
    public readonly shouldFail = false,
  ) {}
}

/**
 * Default dataSource (billing). `@Transactional()` opens a billing-DS
 * transaction; `aggregate.commit()` enqueues the event as an
 * AFTER_COMMIT hook on THAT transaction (Phase 14.3.1 Category B).
 *
 * `EventPublisher.mergeObjectContext` retargets `aggregate.commit()`
 * through `TransactionalEventPublisher` — events become hooks instead
 * of immediate dispatches.
 */
@CommandHandler(IssueInvoiceCommand)
export class IssueInvoiceHandler implements ICommandHandler<IssueInvoiceCommand, void> {
  constructor(
    @InjectRepository(InvoiceRow)
    private readonly invoices: Repository<InvoiceRow>,
    private readonly publisher: EventPublisher,
  ) {}

  @Transactional()
  async execute(command: IssueInvoiceCommand): Promise<void> {
    await this.invoices.save({
      id: command.id,
      customer: command.customer,
      amountCents: command.amountCents,
    });

    const invoice = this.publisher.mergeObjectContext(
      new Invoice(command.id, command.customer, command.amountCents),
    );
    invoice.issue();
    invoice.commit();

    if (command.shouldFail) {
      throw new Error('billing rollback — AFTER_COMMIT skipped, invoice row discarded');
    }
  }
}
