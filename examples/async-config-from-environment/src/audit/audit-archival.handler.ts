import { Injectable, Logger } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';

import type { AuditEventRecordedEvent } from './audit-event-recorded.event.js';

/**
 * Outbox handler, delivered by `@nestjs/outbox`'s relay after the audit
 * transaction commits. Real apps might forward the audit row to a
 * long-term archive (S3, Snowflake) here; this stub just records it in
 * memory so the integration test can assert the delivery happened.
 *
 * It subscribes to the topic the bridge uses for an event without
 * `@Externalized`: its class name. The payload is plain JSON.
 */
@Injectable()
export class AuditArchivalHandler {
  private readonly logger = new Logger(AuditArchivalHandler.name);

  readonly archived: AuditEventRecordedEvent[] = [];

  @OnOutboxMessage('AuditEventRecordedEvent', { consumer: 'audit.archival' })
  async archive(event: AuditEventRecordedEvent): Promise<void> {
    this.logger.log(`Archiving entry ${event.entryId} (${event.eventType})`);
    this.archived.push(event);
  }
}
