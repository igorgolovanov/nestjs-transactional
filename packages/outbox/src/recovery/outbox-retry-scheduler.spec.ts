import { Logger } from '@nestjs/common';

import { FailedEventPublications } from '../api/failed-event-publications';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import type { NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';
import { DEFAULT_RETRY_CONFIG, type OutboxRetryConfig } from '../types/retry-config';

import { OutboxRetryScheduler } from './outbox-retry-scheduler';

/** Deterministic config: no jitter, so eligibility is exactly reproducible. */
const config: OutboxRetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  maxAttempts: 3,
  interval: 60_000,
  baseDelay: 1_000,
  factor: 2,
  maxDelay: 10_000,
  jitter: 0,
  shutdownTimeout: 5_000,
};

function sampleInput(publicationDate: Date): NewEventPublication {
  return {
    listenerId: 'Inventory.onOrderPlaced',
    eventType: 'OrderPlacedEvent',
    serializedEvent: JSON.stringify({ orderId: 'order-1' }),
    publicationDate,
  };
}

describe('OutboxRetryScheduler', () => {
  let repo: InMemoryEventPublicationRepository;
  let failed: FailedEventPublications;
  let scheduler: OutboxRetryScheduler | undefined;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    repo = new InMemoryEventPublicationRepository();
    failed = new FailedEventPublications(repo);
  });

  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
    jest.useRealTimers();
  });

  /**
   * Create a publication already in `FAILED` with a chosen attempt count
   * and age, which is the only state the scheduler cares about.
   */
  async function failedPublication(args: {
    ageMs: number;
    attempts: number;
    lastResubmissionAgeMs?: number;
  }): Promise<string> {
    const [pub] = await repo.createAll([
      sampleInput(new Date(Date.now() - args.ageMs)),
    ]);
    const id = pub!.id;
    for (let i = 0; i < args.attempts; i++) {
      await repo.updateStatus(id, PublicationStatus.PROCESSING, { incrementAttempts: true });
    }
    await repo.updateStatus(id, PublicationStatus.FAILED, {
      failureReason: 'downstream unreachable',
      ...(args.lastResubmissionAgeMs !== undefined
        ? { lastResubmissionDate: new Date(Date.now() - args.lastResubmissionAgeMs) }
        : {}),
    });
    return id;
  }

  function statusOf(id: string): PublicationStatus | undefined {
    return repo.getAll().find((p) => p.id === id)?.status;
  }

  describe('enablement', () => {
    it('does not schedule anything when maxAttempts is 0', () => {
      jest.useFakeTimers();
      scheduler = new OutboxRetryScheduler(failed, { ...config, maxAttempts: 0 });

      scheduler.start();

      expect(jest.getTimerCount()).toBe(0);
    });

    it('schedules the loop when automatic retry is enabled', () => {
      jest.useFakeTimers();
      scheduler = new OutboxRetryScheduler(failed, config);

      scheduler.start();

      expect(jest.getTimerCount()).toBe(1);
    });

    it('start is idempotent', () => {
      jest.useFakeTimers();
      scheduler = new OutboxRetryScheduler(failed, config);

      scheduler.start();
      scheduler.start();

      expect(jest.getTimerCount()).toBe(1);
    });
  });

  describe('backoff', () => {
    it('leaves a publication alone until its first delay has elapsed', async () => {
      // 1 attempt → delay = baseDelay = 1000ms. `lastResubmissionDate`
      // is 200ms old, so it is not due yet.
      const id = await failedPublication({
        ageMs: 60_000,
        attempts: 1,
        lastResubmissionAgeMs: 200,
      });
      scheduler = new OutboxRetryScheduler(failed, config);

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.FAILED);
    });

    it('resubmits once the delay has elapsed', async () => {
      const id = await failedPublication({
        ageMs: 60_000,
        attempts: 1,
        lastResubmissionAgeMs: 1_500,
      });
      scheduler = new OutboxRetryScheduler(failed, config);

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.RESUBMITTED);
    });

    it('grows the delay with each attempt', async () => {
      // 2 attempts → 1000 * 2^1 = 2000ms. 1500ms is enough for attempt 1
      // but not for attempt 2, which is the point of the curve.
      const id = await failedPublication({
        ageMs: 60_000,
        attempts: 2,
        lastResubmissionAgeMs: 1_500,
      });
      scheduler = new OutboxRetryScheduler(failed, config);

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.FAILED);
    });

    it('caps the delay at maxDelay so the curve cannot run away', async () => {
      // 3 attempts would be 1000 * 2^2 = 4000ms, under the 10s cap; a
      // config with a tiny cap must clamp instead.
      const id = await failedPublication({
        ageMs: 600_000,
        attempts: 2,
        lastResubmissionAgeMs: 1_200,
      });
      scheduler = new OutboxRetryScheduler(failed, { ...config, maxDelay: 1_000 });

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.RESUBMITTED);
    });

    it('falls back to publicationDate when the publication has never been resubmitted', async () => {
      // The documented imprecision (DD-026): with no failure timestamp,
      // age is measured from publication, so a long-lived publication
      // that just failed is immediately due for its first retry.
      const id = await failedPublication({ ageMs: 3_600_000, attempts: 1 });
      scheduler = new OutboxRetryScheduler(failed, config);

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.RESUBMITTED);
    });
  });

  describe('attempt cap', () => {
    it('stops retrying once attempts reach maxAttempts', async () => {
      const id = await failedPublication({
        ageMs: 600_000,
        attempts: 3,
        lastResubmissionAgeMs: 600_000,
      });
      scheduler = new OutboxRetryScheduler(failed, config);

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.FAILED);
    });

    it('leaves the exhausted publication queryable rather than hiding it', async () => {
      // No terminal state (DD-026) — the operator API still lists it, so
      // a human can resubmit past the automatic cap.
      await failedPublication({
        ageMs: 600_000,
        attempts: 3,
        lastResubmissionAgeMs: 600_000,
      });
      scheduler = new OutboxRetryScheduler(failed, config);

      await scheduler.runOnce();

      expect(await failed.count()).toBe(1);
    });

    it('retries nothing when maxAttempts is 1 — the first delivery used it up', async () => {
      const id = await failedPublication({
        ageMs: 600_000,
        attempts: 1,
        lastResubmissionAgeMs: 600_000,
      });
      scheduler = new OutboxRetryScheduler(failed, { ...config, maxAttempts: 1 });

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.FAILED);
    });
  });

  describe('batching and reporting', () => {
    it('resubmits at most batchSize publications per pass', async () => {
      for (let i = 0; i < 5; i++) {
        await failedPublication({ ageMs: 600_000, attempts: 1, lastResubmissionAgeMs: 600_000 });
      }
      scheduler = new OutboxRetryScheduler(failed, { ...config, batchSize: 2 });

      const resubmitted = await scheduler.runOnce();

      expect(resubmitted).toBe(2);
      expect(
        repo.getAll().filter((p) => p.status === PublicationStatus.RESUBMITTED),
      ).toHaveLength(2);
    });

    it('reports zero on an empty pass without touching anything', async () => {
      scheduler = new OutboxRetryScheduler(failed, config);

      await expect(scheduler.runOnce()).resolves.toBe(0);
    });
  });

  describe('jitter', () => {
    it('keeps eligibility within the jittered window', async () => {
      // With jitter 1.0 the window is [0, 2 * delay]. An age far beyond
      // that must be eligible no matter which value is drawn, so the
      // spread can never strand a publication.
      const id = await failedPublication({
        ageMs: 600_000,
        attempts: 1,
        lastResubmissionAgeMs: 600_000,
      });
      scheduler = new OutboxRetryScheduler(failed, { ...config, jitter: 1 });

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.RESUBMITTED);
    });

    it('never lets jitter make a brand-new failure eligible', async () => {
      const id = await failedPublication({
        ageMs: 60_000,
        attempts: 1,
        lastResubmissionAgeMs: 0,
      });
      scheduler = new OutboxRetryScheduler(failed, { ...config, jitter: 1 });

      await scheduler.runOnce();

      expect(statusOf(id)).toBe(PublicationStatus.FAILED);
    });
  });

  describe('resilience', () => {
    it('never rejects when the repository fails', async () => {
      jest.spyOn(repo, 'findFailed').mockRejectedValueOnce(new Error('DB down'));
      scheduler = new OutboxRetryScheduler(failed, config);

      await expect(scheduler.runOnce()).resolves.toBe(0);
    });
  });

  describe('shutdown drain', () => {
    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    it('waits for an in-flight pass', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      jest.spyOn(repo, 'findFailed').mockImplementation(async () => {
        entered();
        await held;
        return [];
      });

      scheduler = new OutboxRetryScheduler(failed, { ...config, interval: 1 });
      scheduler.start();
      await started;

      let settled = false;
      const stopped = scheduler.stop().then(() => {
        settled = true;
      });

      await sleep(30);
      expect(settled).toBe(false);

      release();
      await stopped;
      expect(settled).toBe(true);
    });

    it('gives up after the drain timeout', async () => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      jest.spyOn(repo, 'findFailed').mockImplementation(async () => {
        entered();
        await new Promise<void>(() => {
          /* never settles */
        });
        return [];
      });

      scheduler = new OutboxRetryScheduler(failed, {
        ...config,
        interval: 1,
        shutdownTimeout: 25,
      });
      scheduler.start();
      await started;

      const warn = jest.spyOn(Logger.prototype, 'warn');
      await scheduler.stop();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('drain timed out'));
    });
  });
});
