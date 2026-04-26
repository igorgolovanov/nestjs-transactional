import type { PublicationStatus } from './publication-status';

/**
 * Persistent record of an event that was published and needs to be
 * delivered to a listener.
 *
 * Inspired by Spring Modulith's `EventPublication`.
 */
export interface EventPublication {
  /** Opaque identifier (UUID). */
  readonly id: string;
  /**
   * Qualified listener name, e.g. `"InventoryManagement.on(OrderCompletedEvent)"`.
   * Used as a stable identity for retry / resume — see ADR-009 (planned).
   */
  readonly listenerId: string;
  /** The event's class name (discriminator for deserialization). */
  readonly eventType: string;
  /** JSON-serialized event payload. */
  readonly serializedEvent: string;
  /** Wall-clock time at which the publication was created. */
  readonly publicationDate: Date;
  /** Current lifecycle state. */
  readonly status: PublicationStatus;
  /** When the publication reached {@link PublicationStatus.COMPLETED}. */
  readonly completionDate: Date | null;
  /** When the publication was last moved to {@link PublicationStatus.RESUBMITTED}. */
  readonly lastResubmissionDate: Date | null;
  /** Starts at 0, incremented each time a listener picks up the publication. */
  readonly completionAttempts: number;
  /** Error message from the most recent failure, if any. */
  readonly failureReason: string | null;
}

/**
 * Input accepted by the registry for creating a new publication.
 *
 * The registry fills in `id`, `status` (`PUBLISHED`), `completionDate`
 * (`null`), `lastResubmissionDate` (`null`), `completionAttempts` (`0`),
 * and `failureReason` (`null`). If `publicationDate` is omitted, the
 * registry defaults it to "now".
 */
export interface NewEventPublication {
  readonly listenerId: string;
  readonly eventType: string;
  readonly serializedEvent: string;
  readonly publicationDate?: Date;
}
