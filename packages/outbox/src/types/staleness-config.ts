import { DEFAULT_DRAIN_TIMEOUT_MS } from '../shutdown/drain';

/**
 * Configuration for detecting stale publications that should be marked
 * as {@link PublicationStatus.FAILED}.
 *
 * Any value of `0` disables that specific staleness check.
 */
export interface StalenessConfig {
  /** Max duration (ms) in `PUBLISHED` state before marking as `FAILED`. */
  readonly published: number;
  /** Max duration (ms) in `PROCESSING` state before marking as `FAILED`. */
  readonly processing: number;
  /** Max duration (ms) in `RESUBMITTED` state before marking as `FAILED`. */
  readonly resubmitted: number;
  /** How often (ms) the staleness monitor runs. Defaults to 60000 (1 minute). */
  readonly monitorInterval: number;
  /**
   * How long (ms) `stop()` waits for an in-flight staleness sweep to
   * finish before abandoning it. A sweep is framework-controlled
   * database work rather than user code, so it normally completes well
   * inside the budget; the bound exists so a hung query cannot stall
   * shutdown. `0` disables the wait entirely.
   */
  readonly shutdownTimeout: number;
}

export const DEFAULT_STALENESS_CONFIG: StalenessConfig = {
  published: 0,
  processing: 0,
  resubmitted: 0,
  monitorInterval: 60_000,
  shutdownTimeout: DEFAULT_DRAIN_TIMEOUT_MS,
};
