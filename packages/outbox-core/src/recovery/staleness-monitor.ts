import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  EVENT_PUBLICATION_REPOSITORY,
  type EventPublicationRepository,
} from '../repository/event-publication-repository';
import { PublicationStatus } from '../types/publication-status';
import type { StalenessConfig } from '../types/staleness-config';

/**
 * Periodic watchdog that flips publications stuck in non-terminal
 * states to `FAILED` once they have been in that state for longer
 * than the configured threshold.
 *
 * Per-state thresholds live in {@link StalenessConfig} and a value of
 * `0` disables the corresponding check. When every threshold is `0`,
 * {@link start} is a no-op — we do not schedule the polling loop just
 * to do nothing on every tick.
 *
 * Note: the `PROCESSING` / `RESUBMITTED` thresholds are evaluated
 * against the publication's `publicationDate`, not against the moment
 * it entered the current state. Real backends (outbox-typeorm) can
 * refine this with per-state timestamps; the in-memory reference
 * keeps it simple.
 */
@Injectable()
export class StalenessMonitor {
  private readonly logger = new Logger(StalenessMonitor.name);
  private running = false;
  private monitorLoop: NodeJS.Timeout | null = null;

  constructor(
    @Inject(EVENT_PUBLICATION_REPOSITORY)
    private readonly repository: EventPublicationRepository,
    private readonly config: StalenessConfig,
  ) {}

  /** Start the watchdog. Idempotent. */
  start(): void {
    if (this.running) {
      return;
    }

    if (
      this.config.published === 0 &&
      this.config.processing === 0 &&
      this.config.resubmitted === 0
    ) {
      this.logger.log('StalenessMonitor disabled (all thresholds = 0)');
      return;
    }

    this.running = true;
    this.scheduleNext();
    this.logger.log(`StalenessMonitor started (interval: ${this.config.monitorInterval}ms)`);
  }

  /** Stop the watchdog and cancel any pending scheduled tick. */
  stop(): void {
    this.running = false;
    if (this.monitorLoop !== null) {
      clearTimeout(this.monitorLoop);
      this.monitorLoop = null;
    }
  }

  /**
   * Run a single staleness sweep — invoked both by the scheduled loop
   * and directly by tests / one-shot tooling. Never rejects; infra
   * failures are caught and logged.
   */
  async checkStaleness(): Promise<void> {
    try {
      const now = Date.now();

      if (this.config.published > 0) {
        await this.markStale(
          new Date(now - this.config.published),
          [PublicationStatus.PUBLISHED],
          'Publication stale in PUBLISHED state',
        );
      }

      if (this.config.processing > 0) {
        await this.markStale(
          new Date(now - this.config.processing),
          [PublicationStatus.PROCESSING],
          'Publication stale in PROCESSING state',
        );
      }

      if (this.config.resubmitted > 0) {
        await this.markStale(
          new Date(now - this.config.resubmitted),
          [PublicationStatus.RESUBMITTED],
          'Publication stale in RESUBMITTED state',
        );
      }
    } catch (err) {
      this.logger.error(
        'Staleness check failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    this.monitorLoop = setTimeout(() => {
      void this.checkStaleness().finally(() => this.scheduleNext());
    }, this.config.monitorInterval);
  }

  private async markStale(
    beforeDate: Date,
    statuses: PublicationStatus[],
    reason: string,
  ): Promise<void> {
    const stale = await this.repository.findStale(beforeDate, statuses);
    if (stale.length === 0) {
      return;
    }

    this.logger.warn(
      `Found ${stale.length} stale publication(s) in states [${statuses.join(',')}]`,
    );

    for (const pub of stale) {
      await this.repository.updateStatus(pub.id, PublicationStatus.FAILED, {
        failureReason: reason,
      });
    }
  }
}
