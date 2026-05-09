import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { ReservationPlacedEvent } from './reservation-placed.event';
import { ReservationRow } from './reservation.entity';

/**
 * Operates exclusively on the `inventory` schema. Same atomicity
 * contract (DD-019) as billing — `inventory.reservations` and
 * `inventory.event_publication` writes commit together or roll back
 * together.
 */
@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(ReservationRow, 'inventory')
    private readonly reservations: Repository<ReservationRow>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional({ dataSource: 'inventory' })
  async placeReservation(id: string, sku: string, quantity: number): Promise<void> {
    await this.reservations.save({ id, sku, quantity });
    await this.outbox.publish(new ReservationPlacedEvent(id, sku, quantity));
  }

  @Transactional({ dataSource: 'inventory' })
  async placeReservationAndFail(id: string, sku: string, quantity: number): Promise<void> {
    await this.reservations.save({ id, sku, quantity });
    await this.outbox.publish(new ReservationPlacedEvent(id, sku, quantity));
    throw new Error('inventory rollback — reservation + publication discarded');
  }
}
