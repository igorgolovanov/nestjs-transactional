import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  EVENT_PUBLICATION_REPOSITORY,
  EventPublicationProcessor,
  type EventPublicationRepository,
  PublicationStatus,
} from '@nestjs-transactional/outbox';

/**
 * Drain timeout. Real deployments usually align this with the
 * platform's grace period — Kubernetes' `terminationGracePeriodSeconds`
 * defaults to 30s. Leaving a safety margin (5–10s) so the rest of
 * the shutdown path (closing DB pool, flushing logs) gets time too.
 */
export const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_INTERVAL_MS = 50;

/**
 * User-side complement to the framework's
 * `OutboxProcessingModule.onApplicationShutdown`. The framework hook
 * sets `running = false` and clears the next-poll `setTimeout`, but
 * it does NOT await the in-flight `processBatch()` call already
 * dispatched via the previous tick. Without an awaited drain, the
 * NestJS shutdown sequence proceeds to close the DataSource provider
 * — which can interrupt a publication's `PROCESSING → COMPLETED`
 * transition mid-flight, leaving rows stuck in `PROCESSING` for the
 * staleness monitor to recover later.
 *
 * This service plugs that gap with a polling drain:
 *
 * 1. Idempotently call `processor.stop()` so we don't race the
 *    framework hook (and so this works even before the framework's
 *    own hook has fired).
 * 2. Poll {@link EventPublicationRepository.findIncomplete} until no
 *    row is in `PROCESSING` state, or {@link DRAIN_TIMEOUT_MS} elapses.
 *
 * The timeout is the operator's safety net: a stuck handler should
 * not block deployment indefinitely. Anything still `PROCESSING`
 * after the timeout is recovered by the staleness monitor on the
 * next boot — the property of the framework being eventually
 * consistent (rather than zero-loss-on-shutdown) is preserved.
 */
@Injectable()
export class OutboxDrainService implements OnApplicationShutdown {
  private readonly logger = new Logger(OutboxDrainService.name);

  drained = false;
  drainDurationMs = 0;
  drainTimedOut = false;

  constructor(
    private readonly processor: EventPublicationProcessor,
    @Inject(EVENT_PUBLICATION_REPOSITORY)
    private readonly repository: EventPublicationRepository,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Draining outbox (signal=${signal ?? 'none'})…`);
    const start = Date.now();

    // Idempotent — framework hook also calls this. Calling first
    // here ensures that even if NestJS reverse-shutdown-order runs
    // our hook before the framework's, no new batch starts after
    // this point.
    this.processor.stop();

    const deadline = start + DRAIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const inFlight = (await this.repository.findIncomplete()).filter(
        (p) => p.status === PublicationStatus.PROCESSING,
      );
      if (inFlight.length === 0) {
        this.drained = true;
        this.drainDurationMs = Date.now() - start;
        this.logger.log(`Outbox drained cleanly in ${this.drainDurationMs}ms`);
        return;
      }
      await sleep(DRAIN_POLL_INTERVAL_MS);
    }

    this.drainTimedOut = true;
    this.drainDurationMs = Date.now() - start;
    const stillInFlight = (await this.repository.findIncomplete()).filter(
      (p) => p.status === PublicationStatus.PROCESSING,
    );
    this.logger.warn(
      `Outbox drain timed out after ${DRAIN_TIMEOUT_MS}ms — ` +
        `${stillInFlight.length} publication(s) still PROCESSING. ` +
        `Staleness monitor will recover them on the next boot.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
