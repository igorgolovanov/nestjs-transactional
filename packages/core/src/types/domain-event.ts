/**
 * Marker interface for domain events routed through the transactional
 * event dispatcher. Purely structural — any value with a compatible shape
 * satisfies it.
 *
 * Exists to document intent in handler and listener signatures and to keep
 * cross-package type references consistent without importing
 * `@nestjs/cqrs` into core.
 */
export interface DomainEvent {
  /**
   * Wall-clock time at which the event was produced. Optional: some
   * producers may omit it and let the dispatcher stamp it when the event
   * is enqueued.
   */
  readonly occurredAt?: Date;
}
