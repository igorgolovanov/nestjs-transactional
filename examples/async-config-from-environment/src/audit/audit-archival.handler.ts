import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { AuditEventRecordedEvent } from './audit-event-recorded.event';

/**
 * Outbox listener — pushed by the per-DS worker (REQUIRES_NEW
 * transaction by default). Real apps might forward the audit row to
 * a long-term archive (S3, Snowflake) here; this stub just records
 * it in memory so the integration test can assert that the worker
 * actually dispatched.
 *
 * Without at least one listener registered, `OutboxEventPublisher`
 * silently drops `publish` calls (Convention #15) — even with
 * `forFeature` registration. So the example needs *some* handler
 * here even if it does nothing useful.
 */
@Injectable()
@OutboxEventsHandler({ events: [AuditEventRecordedEvent], id: 'Audit.Archival' })
export class AuditArchivalHandler implements IOutboxEventHandler<AuditEventRecordedEvent> {
  private readonly logger = new Logger(AuditArchivalHandler.name);

  readonly archived: AuditEventRecordedEvent[] = [];

  async handle(event: AuditEventRecordedEvent): Promise<void> {
    this.logger.log(`Archiving entry ${event.entryId} (${event.eventType})`);
    this.archived.push(event);
  }
}
