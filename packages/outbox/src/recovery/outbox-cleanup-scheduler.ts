import { Injectable, Logger } from '@nestjs/common';

import type { EventPublicationRepository } from '../repository/event-publication-repository';
import { drainWithTimeout } from '../shutdown/drain';
import type { OutboxCleanupConfig } from '../types/cleanup-config';

/**
 * Periodically removes publications that have been `COMPLETED` longer
 * than the configured retention window (C4).
 *
 * Under the default `UPDATE` completion mode a delivered publication
 * stays as an audit row forever. The primitives to purge it have always
 * existed on the operator API; what was missing was anything to run
 * them on a schedule.
 *
 * Disabled unless `config.interval > 0`, in which case {@link start}
 * never schedules the loop and says so once in the log.
 *
 * Deliberately bounded rather than issuing one `DELETE` over the whole
 * retention window: it selects up to `batchSize` eligible publications
 * with `findCompleted` and deletes them one at a time. That costs more
 * round-trips, and buys two things worth more. A pass cannot turn into a
 * single long transaction holding locks that writers need, which is the
 * realistic hazard on the first pass after enabling cleanup on an
 * existing deployment. And it uses only methods
 * {@link EventPublicationRepository} already had, so it needs no SPI
 * change and behaves identically for a third-party implementation.
 *
 * `CompletedEventPublications.purge(...)` stays what it was: the
 * operator-facing one-shot for a deliberate bulk purge, where a single
 * statement is what you want.
 */
@Injectable()
export class OutboxCleanupScheduler {
  private readonly logger = new Logger(OutboxCleanupScheduler.name);
  private running = false;
  private cleanupLoop: NodeJS.Timeout | null = null;
  /** The pass currently running, or `null` when idle. See {@link stop}. */
  private inFlightPass: Promise<unknown> | null = null;

  constructor(
    private readonly repository: EventPublicationRepository,
    private readonly config: OutboxCleanupConfig,
  ) {}

  /** Start the cleanup loop. Idempotent; a no-op when cleanup is disabled. */
  start(): void {
    if (this.running) {
      return;
    }

    if (this.config.interval <= 0) {
      this.logger.log('OutboxCleanupScheduler disabled (interval = 0)');
      return;
    }

    this.running = true;
    this.scheduleNext();
    this.logger.log(
      `OutboxCleanupScheduler started (interval: ${this.config.interval}ms, ` +
        `retention: ${this.config.retention}ms, batchSize: ${this.config.batchSize})`,
    );
  }

  /**
   * Stop the loop and drain the pass already in flight, bounded by
   * `config.shutdownTimeout`. Idempotent; never rejects.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.cleanupLoop !== null) {
      clearTimeout(this.cleanupLoop);
      this.cleanupLoop = null;
    }

    const inFlight = this.inFlightPass;
    if (inFlight !== null) {
      const drained = await drainWithTimeout(inFlight, this.config.shutdownTimeout);
      if (!drained) {
        this.logger.warn(
          `OutboxCleanupScheduler drain timed out after ${this.config.shutdownTimeout}ms — ` +
            'the in-flight pass was abandoned.',
        );
      }
    }
  }

  /**
   * Run a single cleanup pass and return how many publications were
   * removed. Invoked by the scheduled loop, and directly by tests and
   * one-shot tooling.
   *
   * Never rejects: a failing pass is logged and reported as `0`, so a
   * database blip cannot kill the loop.
   */
  async runOnce(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - this.config.retention);
      const eligible = await this.repository.findCompleted({
        olderThan: cutoff,
        limit: this.config.batchSize,
      });

      let removed = 0;
      for (const publication of eligible) {
        await this.repository.delete(publication.id);
        removed++;
      }

      if (removed > 0) {
        this.logger.log(
          `Removed ${removed} completed publication(s) older than ${cutoff.toISOString()}`,
        );
      }
      return removed;
    } catch (err) {
      this.logger.error('Cleanup pass failed', err instanceof Error ? err.stack : String(err));
      return 0;
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    this.cleanupLoop = setTimeout(() => {
      this.cleanupLoop = null;
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
