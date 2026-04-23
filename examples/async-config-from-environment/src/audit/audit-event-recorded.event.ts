/**
 * Domain event published from `AuditService.recordEvent`. Registered
 * with `OutboxModule.forFeature([AuditEventRecordedEvent])` so the
 * outbox can serialize it to `event_publication`.
 */
export class AuditEventRecordedEvent {
  constructor(
    public readonly entryId: string,
    public readonly eventType: string,
    public readonly payload: Record<string, unknown>,
  ) {}
}
