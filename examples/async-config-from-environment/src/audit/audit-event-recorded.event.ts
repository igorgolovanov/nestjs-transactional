/**
 * Domain event published from `AuditService.recordEvent`. The outbox
 * bridge adds it under its class name, `AuditEventRecordedEvent`, which
 * `AuditArchivalHandler` subscribes to.
 */
export class AuditEventRecordedEvent {
  constructor(
    readonly entryId: string,
    readonly eventType: string,
    readonly payload: Record<string, unknown>,
  ) {}
}
