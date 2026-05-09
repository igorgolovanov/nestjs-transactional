import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { ReservationEntity } from './entities';
import { ReservationPlacedEvent } from './events';

/**
 * Bound to the **inventory** DataSource via
 * `@Transactional({ dataSource: 'inventory' })` — the active
 * transaction context resolves to the inventory DS. The smart-facade
 * `OutboxEventPublisher` then writes the publication row to the
 * inventory DS's `event_publication` table (DD-023 isolation: the
 * billing DS's outbox stack never sees this event).
 *
 * `@InjectRepository(ReservationEntity, 'inventory')` — the second
 * argument selects the named DataSource registration; standard
 * `@nestjs/typeorm` convention.
 */
@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(ReservationEntity, 'inventory')
    private readonly reservations: Repository<ReservationEntity>,
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional({ dataSource: 'inventory' })
  async placeReservation(
    reservationId: string,
    sku: string,
    quantity: number,
    fail = false,
  ): Promise<void> {
    await this.reservations.save({ id: reservationId, sku, quantity });
    await this.outbox.publish(new ReservationPlacedEvent(reservationId, sku, quantity));
    if (fail) throw new Error('inventory rollback');
  }

  async listAll(): Promise<ReservationEntity[]> {
    return this.reservations.find();
  }
}
