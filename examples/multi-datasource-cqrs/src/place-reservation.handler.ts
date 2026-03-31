import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { ReservationRow } from './entities';
import { Reservation } from './reservation.aggregate';

export class PlaceReservationCommand {
  constructor(
    public readonly id: string,
    public readonly sku: string,
    public readonly quantity: number,
    public readonly shouldFail = false,
  ) {}
}

/**
 * Inventory dataSource. `@Transactional({ dataSource: 'inventory' })`
 * opens the transaction on the inventory adapter — Phase 14.3.1
 * Category B's `TransactionalEventDispatcher.scheduleDispatch`
 * resolves the listener's bound DS via
 * `TransactionContext.getActiveTransactionByDataSource('inventory')`
 * and pushes the AFTER_COMMIT hook directly onto THIS transaction's
 * hook list, NOT the default DS's.
 */
@CommandHandler(PlaceReservationCommand)
export class PlaceReservationHandler implements ICommandHandler<PlaceReservationCommand, void> {
  constructor(
    @InjectRepository(ReservationRow, 'inventory')
    private readonly reservations: Repository<ReservationRow>,
    private readonly publisher: EventPublisher,
  ) {}

  @Transactional({ dataSource: 'inventory' })
  async execute(command: PlaceReservationCommand): Promise<void> {
    await this.reservations.save({
      id: command.id,
      sku: command.sku,
      quantity: command.quantity,
    });

    const reservation = this.publisher.mergeObjectContext(
      new Reservation(command.id, command.sku, command.quantity),
    );
    reservation.place();
    reservation.commit();

    if (command.shouldFail) {
      throw new Error('inventory rollback — AFTER_COMMIT skipped, reservation row discarded');
    }
  }
}
