import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { InjectOutboxPublisher, OutboxEventPublisher } from '@nestjs-transactional/outbox';
import { Repository } from 'typeorm';

import { AuditEventRecordedEvent } from './audit-event-recorded.event';
import { AuditLogEntry } from './audit-log.entity';

/**
 * Single transactional method. The shutdown story for the producer
 * side is straightforward: NestJS's `app.close()` runs lifecycle
 * hooks, and as long as user code is `await`-ing the result of
 * `recordEvent`, the framework drains it before destroying the
 * DataSource provider. This service is identical to its baseline
 * (basic-typeorm-outbox) — the interesting code lives in
 * `src/shutdown/`.
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
  async recordEvent(entryId: string, message: string): Promise<void> {
    await this.entries.insert({ id: entryId, message, createdAt: new Date() });
    await this.outbox.publish(new AuditEventRecordedEvent(entryId, message));
  }

  async findAll(): Promise<AuditLogEntry[]> {
    return this.entries.find({ order: { createdAt: 'ASC' } });
  }
}
