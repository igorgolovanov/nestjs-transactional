import { DEFAULT_DRAIN_TIMEOUT_MS } from '../shutdown/drain';

/**
 * Retention policy for publications that reached `COMPLETED`.
 *
 * Under the default `UPDATE` completion mode a delivered publication
 * stays in the table as an audit record, and nothing removes it. That is
 * deliberate, but it means the table grows without bound unless someone
 * purges it. This config puts that purge on a timer.
 *
 * Disabled unless you ask for it: `interval: 0` means the scheduler
 * never schedules its loop, following the same "0 disables" convention
 * as {@link StalenessConfig} and {@link OutboxRetryConfig}. It says so
 * in the log on boot rather than staying quiet, so a half-configured
 * policy is visible instead of silently inert.
 */
export interface OutboxCleanupConfig {
  /**
   * How often (ms) a purge pass runs. `0` disables cleanup entirely, in
   * which case retention stays manual through
   * `CompletedEventPublications.purge(...)`.
   */
  readonly interval: number;
  /**
   * How long (ms) a publication is kept after completion. A pass removes
   * only rows whose `completionDate` is older than this.
   *
   * `0` is allowed and means "no grace period": everything already
   * `COMPLETED` at the moment of the pass is eligible. That is a
   * reasonable choice when the row carries no audit value, and a poor
   * one when it does, so it is not the default.
   */
  readonly retention: number;
  /**
   * Maximum publications removed per pass.
   *
   * The bound is the point. A single unbounded `DELETE` across a mature
   * table is one long transaction holding locks the writers need, and
   * the first pass after enabling cleanup on an existing deployment is
   * exactly when that table is at its largest. Passes are cheap and
   * frequent, so a backlog drains over several of them instead.
   */
  readonly batchSize: number;
  /**
   * How long (ms) `stop()` waits for an in-flight pass to finish before
   * abandoning it. `0` disables the wait.
   *
   * Abandoning a pass is safe: deletion is per-publication, so an
   * interrupted pass leaves the rows it had not reached yet, and the
   * next pass picks them up.
   */
  readonly shutdownTimeout: number;
}

/**
 * Cleanup off; every other value is what it would use if switched on.
 * Seven days of retention is a starting point rather than a
 * recommendation: the right window depends on what the audit trail is
 * for in a given deployment.
 */
export const DEFAULT_CLEANUP_CONFIG: OutboxCleanupConfig = {
  interval: 0,
  retention: 7 * 24 * 60 * 60 * 1000,
  batchSize: 500,
  shutdownTimeout: DEFAULT_DRAIN_TIMEOUT_MS,
};
