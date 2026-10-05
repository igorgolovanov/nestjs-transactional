/**
 * Domain event published from `AuditService.recordEvent`. The outbox
 * bridge adds it under its class name, `AuditEventRecordedEvent`, which
 * `AuditArchivalHandler` subscribes to.
 */
export class AuditEventRecordedEvent {
  constructor(
    public readonly entryId: string,
    public readonly eventType: string,
    public readonly payload: Record<string, unknown>,
  ) {}
}
