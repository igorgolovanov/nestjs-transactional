import type { EventPublication, NewEventPublication } from '../types/event-publication';
import type { PublicationStatus } from '../types/publication-status';

/**
 * Options accepted by {@link EventPublicationRepository.updateStatus}.
 */
export interface UpdateStatusOptions {
  /** Set when transitioning to `COMPLETED` so downstream tools can audit. */
  readonly completionDate?: Date;
  /** Populated when transitioning to `FAILED`. */
  readonly failureReason?: string;
  /**
   * Increment `completionAttempts` by one as part of the update.
   * Used when a listener picks up a publication via `tryClaim`.
   */
  readonly incrementAttempts?: boolean;
  /** Set when transitioning to `RESUBMITTED`. */
  readonly lastResubmissionDate?: Date;
}

/**
 * Options accepted by {@link EventPublicationRepository.findCompleted}.
 */
export interface FindCompletedOptions {
  /** Only include publications whose `completionDate` is strictly before this. */
  readonly olderThan?: Date;
  /** Cap the number of returned rows. */
  readonly limit?: number;
}

/**
 * Options accepted by {@link EventPublicationRepository.findFailed}.
 */
export interface FindFailedOptions {
  /** Minimum age (ms since `publicationDate`) for the row to be included. */
  readonly minAge?: number;
  /** Only include rows with `completionAttempts <= maxAttempts`. */
  readonly maxAttempts?: number;
}

/**
 * Persistence SPI for event publications.
 *
 * Implementations provide storage (TypeORM, Prisma, MongoDB, ...).
 *
 * All mutating operations are expected to participate in the ambient
 * transaction (through the `AsyncLocalStorage` context provided by
 * `@nestjs-transactional/core`) when one is active, so publication
 * rows are committed atomically with the business data.
 */
export interface EventPublicationRepository {
  /**
   * Create multiple publications atomically. Called during event
   * publishing — one entry per listener registered for the event.
   */
  createAll(publications: NewEventPublication[]): Promise<EventPublication[]>;

  /** Lookup a publication by its id, or `null` when not found. */
  findById(id: string): Promise<EventPublication | null>;

  /**
   * Update a publication's status. Used for lifecycle transitions:
   * - `PUBLISHED` → `PROCESSING` (a listener has picked it up)
   * - `PROCESSING` → `COMPLETED` (success)
   * - `PROCESSING` → `FAILED` (exception)
   * - `FAILED` → `RESUBMITTED` (operator resubmit)
   */
  updateStatus(id: string, status: PublicationStatus, options?: UpdateStatusOptions): Promise<void>;

  /**
   * Atomically claim a publication: transition `PUBLISHED` or
   * `RESUBMITTED` → `PROCESSING` (and increment `completionAttempts`)
   * iff the current status is one of those. Returns `true` when the
   * claim succeeded, `false` otherwise.
   *
   * **This method carries the SPI's whole concurrency guarantee.** It is
   * what prevents double-processing across workers, so the status check
   * and the transition MUST be one indivisible operation — a conditional
   * `UPDATE ... WHERE status IN (...)` reporting affected-row count, a
   * `findOneAndUpdate` with the status in the filter, or an equivalent
   * compare-and-set. A read-then-write implementation is incorrect: two
   * workers would both observe `PUBLISHED` and both dispatch.
   *
   * See DD-025.
   */
  tryClaim(id: string): Promise<boolean>;

  /**
   * Find publications ready for processing (status `PUBLISHED` or
   * `RESUBMITTED`), oldest first.
   *
   * Deliberately NOT exclusive: implementations need not lock rows or
   * hand out disjoint sets, and concurrent workers may receive
   * overlapping results. Correctness comes from {@link tryClaim} — a
   * worker that loses the claim skips the publication without invoking
   * its listener, so overlap costs a wasted read, never a duplicate
   * dispatch.
   *
   * Row-locking implementations (`SELECT ... FOR UPDATE SKIP LOCKED`)
   * are permitted but not expected, and neither shipped implementation
   * uses one: a pessimistic lock has to be held by a transaction that
   * spans the listener invocation, which is unsafe for long-running
   * listeners. See DD-025.
   */
  findReadyForProcessing(limit: number): Promise<EventPublication[]>;

  /**
   * Find publications in the given statuses whose `publicationDate` is
   * strictly before `beforeDate`. Used by the staleness monitor.
   */
  findStale(beforeDate: Date, statuses: PublicationStatus[]): Promise<EventPublication[]>;

  /**
   * Find all completed publications, with optional pagination / cutoff,
   * ordered by `completionDate` **oldest first**.
   *
   * The ordering is part of the contract because `limit` makes it one.
   * A retention job asks for a bounded page and deletes it; if the page
   * came back newest-first, a job that cannot keep up with the
   * completion rate would delete only the recent rows and never reach
   * the old ones, which is the exact opposite of what a retention window
   * promises. Draining from the oldest end degrades correctly instead:
   * falling behind shrinks the backlog, it does not strand its tail.
   */
  findCompleted(options?: FindCompletedOptions): Promise<EventPublication[]>;

  /**
   * Find all incomplete publications (status other than `COMPLETED`).
   * Backs the `IncompleteEventPublications` operator API.
   */
  findIncomplete(): Promise<EventPublication[]>;

  /**
   * Find failed publications. Backs the `FailedEventPublications`
   * operator API.
   */
  findFailed(options?: FindFailedOptions): Promise<EventPublication[]>;

  /**
   * Delete completed publications whose `completionDate` is strictly
   * before `olderThan` (or all completed publications when the argument
   * is omitted). Returns the number of rows removed.
   */
  deleteCompleted(olderThan?: Date): Promise<number>;

  /**
   * Archive a completed publication. Implementation-specific — typical
   * TypeORM backend copies the row to an archive table before removing
   * it from the hot queue.
   */
  archiveCompleted(id: string): Promise<void>;

  /** Delete a single publication by id. Used for `DELETE` completion mode. */
  delete(id: string): Promise<void>;
}

/** DI token for the active {@link EventPublicationRepository}. */
export const EVENT_PUBLICATION_REPOSITORY = Symbol('EVENT_PUBLICATION_REPOSITORY');
