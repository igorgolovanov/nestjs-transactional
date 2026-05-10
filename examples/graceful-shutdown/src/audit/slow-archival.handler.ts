import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { AuditEventRecordedEvent } from './audit-event-recorded.event';

/**
 * Outbox handler that artificially takes ~`HANDLER_LATENCY_MS` to
 * complete one event. The latency simulates real I/O work
 * (HTTP call to an archive API, S3 upload, etc.) and lets the
 * integration test trigger shutdown WHILE a handler invocation is
 * in flight — proving (or refuting) that the in-flight work
 * completes cleanly before the DataSource is torn down.
 *
 * Each invocation increments two counters (started, finished) so
 * tests can detect partial-completion scenarios where shutdown
 * cut a handler short.
 */
export const HANDLER_LATENCY_MS = 400;

@Injectable()
@OutboxEventsHandler({ events: [AuditEventRecordedEvent], id: 'Audit.SlowArchival' })
export class SlowArchivalHandler implements IOutboxEventHandler<AuditEventRecordedEvent> {
  private readonly logger = new Logger(SlowArchivalHandler.name);

  started = 0;
  finished = 0;
  readonly archived: AuditEventRecordedEvent[] = [];

  async handle(event: AuditEventRecordedEvent): Promise<void> {
    this.started += 1;
    this.logger.log(`Archiving entry ${event.entryId} (started=${this.started})`);

    await new Promise((resolve) => setTimeout(resolve, HANDLER_LATENCY_MS));

    this.archived.push(event);
    this.finished += 1;
    this.logger.log(`Archived entry ${event.entryId} (finished=${this.finished})`);
  }
}
