import { DEFAULT_DRAIN_TIMEOUT_MS } from '../shutdown/drain';
import { CompletionMode } from '../types/completion-mode';

/**
 * Tunables for the {@link EventPublicationProcessor} polling loop.
 *
 * Values are enforced at injection time — provide a fully-populated
 * object (merge with {@link DEFAULT_PROCESSOR_OPTIONS} if you only
 * want to override a subset).
 */
export interface EventPublicationProcessorOptions {
  /** Milliseconds to wait between polling cycles. */
  readonly pollingInterval: number;
  /** Maximum publications fetched per poll. */
  readonly batchSize: number;
  /** Maximum listener invocations that may run in parallel inside one batch. */
  readonly maxConcurrent: number;
  /** How a successfully-delivered publication is finalized. */
  readonly completionMode: CompletionMode;
  /**
   * How long (ms) `stop()` waits for an in-flight batch to finish
   * before abandoning it. Set it below the platform's shutdown grace
   * period so the rest of the teardown still has room.
   *
   * A publication abandoned mid-flight stays in `PROCESSING` and is
   * recovered by the staleness monitor on a later boot, so this is a
   * latency/consistency trade-off rather than a data-loss one. `0`
   * disables the wait entirely.
   */
  readonly shutdownTimeout: number;
}

/**
 * Reasonable defaults for local development — a 1-second poll, 100 rows
 * per batch, 10 parallel listener invocations, `UPDATE` completion, and
 * a 10-second shutdown drain.
 */
export const DEFAULT_PROCESSOR_OPTIONS: EventPublicationProcessorOptions = {
  pollingInterval: 1000,
  batchSize: 100,
  maxConcurrent: 10,
  completionMode: CompletionMode.UPDATE,
  shutdownTimeout: DEFAULT_DRAIN_TIMEOUT_MS,
};
