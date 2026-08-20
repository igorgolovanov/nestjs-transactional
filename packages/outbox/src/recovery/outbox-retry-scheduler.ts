import { Injectable, Logger } from '@nestjs/common';

import { FailedEventPublications } from '../api/failed-event-publications';
import { drainWithTimeout } from '../shutdown/drain';
import type { EventPublication } from '../types/event-publication';
import { ResubmissionOptions } from '../types/resubmission-options';
import type { OutboxRetryConfig } from '../types/retry-config';

/**
 * Periodically resubmits `FAILED` publications whose backoff window has
 * elapsed, up to a per-publication attempt cap (DD-026).
 *
 * Deliberately a thin scheduler over
 * {@link FailedEventPublications.resubmit} rather than a second
 * resubmission path: automatic retry is the same operation an operator
 * performs by hand, on a timer, with a backoff predicate as the filter.
 * Spring Modulith stops at the manual API — this is where we go one step
 * past parity, and keeping it layered is what makes that step cheap to
 * reason about.
 *
 * Disabled unless `config.maxAttempts > 0`, in which case {@link start}
 * never schedules the loop. A publication that exhausts its attempts is
 * simply no longer selected; it stays `FAILED` and remains available to
 * the operator APIs.
 */
@Injectable()
export class OutboxRetryScheduler {
  private readonly logger = new Logger(OutboxRetryScheduler.name);
  private running = false;
  private retryLoop: NodeJS.Timeout | null = null;
  /** The pass currently running, or `null` when idle. See {@link stop}. */
  private inFlightPass: Promise<unknown> | null = null;

  constructor(
    private readonly failed: FailedEventPublications,
    private readonly config: OutboxRetryConfig,
  ) {}

  /** Start the retry loop. Idempotent; a no-op when retry is disabled. */
  start(): void {
    if (this.running) {
      return;
    }

    if (this.config.maxAttempts <= 0) {
      this.logger.log('OutboxRetryScheduler disabled (maxAttempts = 0)');
      return;
    }

    this.running = true;
    this.scheduleNext();
    this.logger.log(
      `OutboxRetryScheduler started (interval: ${this.config.interval}ms, ` +
        `maxAttempts: ${this.config.maxAttempts})`,
    );
  }

  /**
   * Stop the loop and drain the pass already in flight, bounded by
   * `config.shutdownTimeout`. Idempotent; never rejects.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.retryLoop !== null) {
      clearTimeout(this.retryLoop);
      this.retryLoop = null;
    }

    const inFlight = this.inFlightPass;
    if (inFlight !== null) {
      const drained = await drainWithTimeout(inFlight, this.config.shutdownTimeout);
      if (!drained) {
        this.logger.warn(
          `OutboxRetryScheduler drain timed out after ${this.config.shutdownTimeout}ms — ` +
            'the in-flight pass was abandoned.',
        );
      }
    }
  }

  /**
   * Run a single retry pass and return how many publications were
   * resubmitted. Invoked by the scheduled loop, and directly by tests
   * and one-shot tooling.
   *
   * Never rejects: a failing pass is logged and reported as `0`, so a
   * database blip cannot kill the loop.
   */
  async runOnce(): Promise<number> {
    try {
      const resubmitted = await this.failed.resubmit(
        ResubmissionOptions.defaults()
          .withBatchSize(this.config.batchSize)
          // The repository narrows by attempt count; `maxAttempts` counts
          // the first delivery, so a publication is eligible only while
          // it has attempts left.
          .withMaxAttempts(this.config.maxAttempts - 1)
          .withFilter((publication) => this.isDue(publication)),
      );

      if (resubmitted > 0) {
        this.logger.log(`Resubmitted ${resubmitted} failed publication(s) for retry`);
      }
      return resubmitted;
    } catch (err) {
      this.logger.error('Retry pass failed', err instanceof Error ? err.stack : String(err));
      return 0;
    }
  }

  /**
   * Whether `publication` has waited out its backoff window.
   *
   * The window is measured from the last attempt we can see. There is no
   * failure timestamp in the schema, so a publication that has never
   * been resubmitted is measured from `publicationDate` — which makes
   * its *first* retry eager if it lived a long time before failing.
   * Every later window is exact, because resubmission stamps
   * `lastResubmissionDate`. See DD-026 for why that beats a migration.
   */
  private isDue(publication: EventPublication): boolean {
    const lastAttemptAt = publication.lastResubmissionDate ?? publication.publicationDate;
    const waited = Date.now() - lastAttemptAt.getTime();
    return waited >= this.delayFor(publication.completionAttempts);
  }

  /**
   * `baseDelay * factor^(attempts - 1)`, clamped to `maxDelay` and then
   * spread by `jitter`.
   *
   * Jitter scales the window by a factor in `[1 - jitter, 1 + jitter]`,
   * so retries after a mass failure do not all become due at the same
   * instant. It can shorten a window but never to zero, so a
   * just-failed publication still waits.
   */
  private delayFor(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    const raw = this.config.baseDelay * Math.pow(this.config.factor, exponent);
    const clamped = Math.min(raw, this.config.maxDelay);

    if (this.config.jitter <= 0) {
      return clamped;
    }
    const spread = clamped * this.config.jitter;
    return clamped - spread + Math.random() * spread * 2;
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    this.retryLoop = setTimeout(() => {
      this.retryLoop = null;
      const pass = this.runOnce();
      this.inFlightPass = pass;
      void pass.finally(() => {
        if (this.inFlightPass === pass) {
          this.inFlightPass = null;
        }
        this.scheduleNext();
      });
    }, this.config.interval);
  }
}
