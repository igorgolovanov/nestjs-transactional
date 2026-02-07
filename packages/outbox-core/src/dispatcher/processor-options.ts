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
}

/**
 * Reasonable defaults for local development — a 1-second poll, 100 rows
 * per batch, 10 parallel listener invocations, and `UPDATE` completion.
 */
export const DEFAULT_PROCESSOR_OPTIONS: EventPublicationProcessorOptions = {
  pollingInterval: 1000,
  batchSize: 100,
  maxConcurrent: 10,
  completionMode: CompletionMode.UPDATE,
};
