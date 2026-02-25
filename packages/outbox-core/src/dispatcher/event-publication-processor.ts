import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  EVENT_EXTERNALIZER,
  type EventExternalizer,
} from '../externalization/event-externalizer';
import { EventPublicationRegistry } from '../registry/event-publication-registry';
import { OutboxListenerRegistry } from '../registry/listener-registry';
import type { EventPublication } from '../types/event-publication';

import type { EventPublicationProcessorOptions } from './processor-options';

/**
 * Async worker that drains the event publication queue:
 *
 * 1. Pulls up to `batchSize` publications in `PUBLISHED` / `RESUBMITTED`
 *    state from the {@link EventPublicationRegistry};
 * 2. atomically claims each one (`PUBLISHED/RESUBMITTED → PROCESSING`)
 *    so concurrent workers cannot double-dispatch;
 * 3. looks up the corresponding listener in the
 *    {@link OutboxListenerRegistry} and invokes it with the
 *    deserialized event;
 * 4. finalizes the publication — `COMPLETED` with the configured
 *    completion mode on success, `FAILED` with the error message
 *    otherwise.
 *
 * Up to `maxConcurrent` invocations run in parallel inside one batch.
 * Listener errors never bubble out: they are caught, logged, and
 * recorded on the publication row.
 */
@Injectable()
export class EventPublicationProcessor {
  private readonly logger = new Logger(EventPublicationProcessor.name);
  private running = false;
  private processingLoop: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: EventPublicationRegistry,
    private readonly listenerRegistry: OutboxListenerRegistry,
    private readonly options: EventPublicationProcessorOptions,
    @Optional()
    @Inject(EVENT_EXTERNALIZER)
    private readonly externalizer?: EventExternalizer,
  ) {}

  /** Start the periodic polling loop. Idempotent. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNext();
    this.logger.log('EventPublicationProcessor started');
  }

  /** Stop the polling loop and cancel any pending scheduled tick. */
  stop(): void {
    this.running = false;
    if (this.processingLoop !== null) {
      clearTimeout(this.processingLoop);
      this.processingLoop = null;
    }
    this.logger.log('EventPublicationProcessor stopped');
  }

  /**
   * Process a single batch of pending publications. Safe to call
   * directly from tests and one-shot tooling; `start()` triggers it
   * periodically.
   *
   * Internal errors (e.g. DB unreachable) are caught and logged —
   * this method never rejects.
   */
  async processBatch(): Promise<void> {
    try {
      const publications = await this.registry.findReadyForProcessing(this.options.batchSize);
      if (publications.length === 0) {
        return;
      }

      this.logger.debug(`Processing batch of ${publications.length} publications`);

      const chunks = this.chunk(publications, this.options.maxConcurrent);
      for (const chunk of chunks) {
        await Promise.all(chunk.map((pub) => this.processOne(pub)));
      }
    } catch (err) {
      this.logger.error(
        'Batch processing failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    this.processingLoop = setTimeout(() => {
      void this.processBatch().finally(() => this.scheduleNext());
    }, this.options.pollingInterval);
  }

  private async processOne(publication: EventPublication): Promise<void> {
    try {
      const claimed = await this.registry.tryClaim(publication.id);
      if (!claimed) {
        return;
      }

      const listener = this.listenerRegistry.getById(publication.listenerId);
      if (listener === undefined) {
        await this.registry.markFailed(
          publication.id,
          `Listener '${publication.listenerId}' is not registered`,
        );
        this.logger.warn(
          `Listener '${publication.listenerId}' not found for publication ${publication.id}`,
        );
        return;
      }

      try {
        const event = this.registry.deserialize(publication);
        // Local listener invocation runs first so cheap, in-process
        // failures fail fast before we touch a broker (DD-019).
        await listener.invoke(event);
        // Externalization is optional and gated by the registry
        // resolution wired in 11.2 — `tryExternalize` is a no-op until
        // ExternalizationRegistry lookup lands.
        await this.tryExternalize(event, publication);
        await this.registry.markCompleted(publication.id, this.options.completionMode);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.registry.markFailed(publication.id, reason);
        this.logger.error(
          `Listener '${publication.listenerId}' failed for publication ${publication.id}: ${reason}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    } catch (err) {
      this.logger.error(
        `Error processing publication ${publication.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Externalize the event after the local listener has succeeded.
   *
   * Phase 11.1 stub: returns immediately when no externalizer is bound
   * AND when no `ExternalizationRegistry` resolution exists yet.
   * Phase 11.2 will look up the publication's `ExternalizationMetadata`
   * via the registry and invoke the bound externalizer when both are
   * present. Implemented as a separate method so the call site in
   * `processOne` already exercises the full success / failure path
   * (any rejection from the externalizer surfaces to the outer try /
   * catch and marks the publication FAILED — DD-019).
   */
  private tryExternalize(
    _event: unknown,
    _publication: EventPublication,
  ): Promise<void> {
    // Phase 11.1 stub: returns a resolved Promise unconditionally.
    // Resolution against `ExternalizationRegistry` lands in Phase 11.2;
    // until then we never invoke the externalizer even when one is
    // bound. The call site in `processOne` already awaits the result,
    // so the success / failure surface area matches the eventual
    // implementation — only the body changes.
    return Promise.resolve();
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
