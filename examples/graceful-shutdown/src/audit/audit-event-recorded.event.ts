/**
 * Domain event published from `AuditService.recordEvent`. Registered
 * via `OutboxModule.forFeature([AuditEventRecordedEvent])`.
 */
export class AuditEventRecordedEvent {
  constructor(
    public readonly entryId: string,
    public readonly message: string,
  ) {}
}
