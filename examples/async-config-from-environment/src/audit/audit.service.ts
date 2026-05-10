import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { InjectOutboxPublisher, OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { AuditEventRecordedEvent } from './audit-event-recorded.event';
import { AuditLogEntry } from './audit-log.entity';

/**
 * Single-method service that demonstrates the framework still
 * behaves identically when wired through `forRootAsync` —
 * `@Transactional()` opens a transaction, the INSERT lands, the
 * outbox publication lands in the same transaction (DD-019). Nothing
 * here changes from the sync-config baseline; that's the point.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLogEntry)
    private readonly entries: Repository<AuditLogEntry>,
    @InjectOutboxPublisher()
    private readonly outbox: OutboxEventPublisher,
  ) {}

  @Transactional()
  async recordEvent(
    entryId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Cast required because TypeORM's `_QueryDeepPartialEntity`
    // recurses into jsonb fields. Without it, an arbitrary
    // `Record<string, unknown>` is rejected.
    await this.entries.insert({
      id: entryId,
      eventType,
      payload: payload as Record<string, never>,
      createdAt: new Date(),
    });
    await this.outbox.publish(new AuditEventRecordedEvent(entryId, eventType, payload));
  }

  async findAll(): Promise<AuditLogEntry[]> {
    return this.entries.find();
  }
}
