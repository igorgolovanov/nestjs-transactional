import { DEFAULT_DRAIN_TIMEOUT_MS } from '../shutdown/drain';

/**
 * Policy for automatically resubmitting `FAILED` publications
 * (see DD-026).
 *
 * Disabled unless you ask for it: `maxAttempts: 0` means no automatic
 * retry and the scheduler never even schedules its timer, following the
 * same "0 disables" convention as `StalenessConfig`. Recovery then stays
 * what it has always been — an operator (or your own scheduled job)
 * calling `FailedEventPublications.resubmit(...)`.
 */
export interface OutboxRetryConfig {
  /**
   * Total attempts a publication gets, counting the first one. `3` means
   * the original delivery plus two automatic retries. `0` disables
   * automatic retry entirely; `1` enables the scheduler but retries
   * nothing, since a `FAILED` publication has already used its single
   * attempt.
   *
   * A publication that exhausts its attempts stays `FAILED` — no
   * separate terminal state (DD-026). It remains visible through
   * `FailedEventPublications.findAll(...)` and an operator can still
   * resubmit it by hand; the cap bounds the automatic path only.
   */
  readonly maxAttempts: number;
  /** How often (ms) the scheduler looks for retry-eligible publications. */
  readonly interval: number;
  /** Delay (ms) before the first retry. */
  readonly baseDelay: number;
  /** Multiplier applied per attempt: `baseDelay * factor^(attempts - 1)`. */
  readonly factor: number;
  /** Ceiling (ms) for the computed delay, so the curve cannot run away. */
  readonly maxDelay: number;
  /**
   * Fraction of the computed delay (`0`–`1`) to spread retries over.
   * `0.2` shortens or lengthens each publication's window by up to 20%
   * at random, so a mass failure does not produce a synchronised retry
   * burst once the downstream recovers. `0` makes eligibility exactly
   * reproducible.
   */
  readonly jitter: number;
  /** Maximum publications resubmitted per pass. */
  readonly batchSize: number;
  /**
   * How long (ms) `stop()` waits for an in-flight pass to finish before
   * abandoning it. `0` disables the wait.
   */
  readonly shutdownTimeout: number;
}

/** Automatic retry off; every other value is the curve it would use if switched on. */
export const DEFAULT_RETRY_CONFIG: OutboxRetryConfig = {
  maxAttempts: 0,
  interval: 60_000,
  baseDelay: 1_000,
  factor: 2,
  maxDelay: 300_000,
  jitter: 0.2,
  batchSize: 100,
  shutdownTimeout: DEFAULT_DRAIN_TIMEOUT_MS,
};
