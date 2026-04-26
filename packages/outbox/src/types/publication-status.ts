/**
 * Lifecycle state of an {@link EventPublication}.
 *
 * Inspired by Spring Modulith's Event Publication Registry.
 *
 * State transitions (normal flow):
 *
 *   PUBLISHED → PROCESSING → COMPLETED
 *
 * State transitions (failure flow):
 *
 *   PUBLISHED → PROCESSING → FAILED → RESUBMITTED → PROCESSING → COMPLETED
 */
export enum PublicationStatus {
  /** Created, waiting to be picked up by a listener. */
  PUBLISHED = 'PUBLISHED',
  /** A listener has picked it up and is currently executing. */
  PROCESSING = 'PROCESSING',
  /** Listener finished successfully. */
  COMPLETED = 'COMPLETED',
  /** Listener threw an exception. */
  FAILED = 'FAILED',
  /** Previously FAILED, now queued for retry. */
  RESUBMITTED = 'RESUBMITTED',
}
