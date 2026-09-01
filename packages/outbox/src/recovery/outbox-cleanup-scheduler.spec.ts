import { Logger } from '@nestjs/common';

import type { EventPublicationRepository } from '../repository/event-publication-repository';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import { DEFAULT_CLEANUP_CONFIG, type OutboxCleanupConfig } from '../types/cleanup-config';
import type { NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';

import { OutboxCleanupScheduler } from './outbox-cleanup-scheduler';

const HOUR = 60 * 60 * 1000;

/** Cleanup on, with a one-hour window and small batches. */
const config: OutboxCleanupConfig = {
  ...DEFAULT_CLEANUP_CONFIG,
  interval: 60_000,
  retention: HOUR,
  batchSize: 2,
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

describe('OutboxCleanupScheduler', () => {
  let repo: InMemoryEventPublicationRepository;
  let scheduler: OutboxCleanupScheduler | undefined;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    repo = new InMemoryEventPublicationRepository();
  });

  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
    jest.useRealTimers();
  });

  /** A publication already `COMPLETED`, completed `completedAgoMs` ago. */
  async function completedPublication(completedAgoMs: number): Promise<string> {
    const [pub] = await repo.createAll([sampleInput(new Date(Date.now() - completedAgoMs))]);
    const id = pub!.id;
    await repo.updateStatus(id, PublicationStatus.COMPLETED, {
      completionDate: new Date(Date.now() - completedAgoMs),
    });
    return id;
  }

  function idsInStore(): string[] {
    return repo.getAll().map((p) => p.id);
  }

  describe('enablement', () => {
    it('does not schedule anything when the interval is 0', () => {
      jest.useFakeTimers();
      scheduler = new OutboxCleanupScheduler(repo, { ...config, interval: 0 });

      scheduler.start();

      expect(jest.getTimerCount()).toBe(0);
    });

    it('is off in the shipped defaults, so cleanup is opt-in', () => {
      jest.useFakeTimers();
      scheduler = new OutboxCleanupScheduler(repo, DEFAULT_CLEANUP_CONFIG);

      scheduler.start();

      expect(jest.getTimerCount()).toBe(0);
    });

    it('schedules the loop when cleanup is enabled', () => {
      jest.useFakeTimers();
      scheduler = new OutboxCleanupScheduler(repo, config);

      scheduler.start();

      expect(jest.getTimerCount()).toBe(1);
    });

    it('start is idempotent', () => {
      jest.useFakeTimers();
      scheduler = new OutboxCleanupScheduler(repo, config);

      scheduler.start();
      scheduler.start();

      expect(jest.getTimerCount()).toBe(1);
    });
  });

  describe('retention window', () => {
    it('keeps a publication that completed inside the window', async () => {
      const id = await completedPublication(HOUR / 2);
      scheduler = new OutboxCleanupScheduler(repo, config);

      const removed = await scheduler.runOnce();

      expect(removed).toBe(0);
      expect(idsInStore()).toEqual([id]);
    });

    it('removes a publication that completed before the window', async () => {
      const id = await completedPublication(2 * HOUR);
      scheduler = new OutboxCleanupScheduler(repo, config);

      const removed = await scheduler.runOnce();

      expect(removed).toBe(1);
      expect(idsInStore()).not.toContain(id);
    });

    it('leaves publications that never completed, whatever their age', async () => {
      const [pub] = await repo.createAll([sampleInput(new Date(Date.now() - 10 * HOUR))]);
      await repo.updateStatus(pub!.id, PublicationStatus.FAILED, {
        failureReason: 'downstream unreachable',
      });
      scheduler = new OutboxCleanupScheduler(repo, config);

      const removed = await scheduler.runOnce();

      expect(removed).toBe(0);
      expect(idsInStore()).toEqual([pub!.id]);
    });
  });

  describe('boundedness', () => {
    it('removes at most batchSize publications per pass', async () => {
      for (let i = 0; i < 5; i++) {
        await completedPublication(2 * HOUR);
      }
      scheduler = new OutboxCleanupScheduler(repo, config);

      const removed = await scheduler.runOnce();

      expect(removed).toBe(2);
      expect(idsInStore()).toHaveLength(3);
    });

    it('drains a backlog over successive passes', async () => {
      for (let i = 0; i < 5; i++) {
        await completedPublication(2 * HOUR);
      }
      scheduler = new OutboxCleanupScheduler(repo, config);

      await scheduler.runOnce();
      await scheduler.runOnce();
      await scheduler.runOnce();

      expect(idsInStore()).toHaveLength(0);
    });

    it('removes the oldest first, so a job that falls behind still drains the tail', async () => {
      // The reason `findCompleted` promises oldest-first. With a bounded
      // batch and the opposite order, the oldest rows would be the ones
      // that survive, which is the inverse of what a retention window
      // promises.
      const oldest = await completedPublication(10 * HOUR);
      const middle = await completedPublication(5 * HOUR);
      const newest = await completedPublication(2 * HOUR);

      scheduler = new OutboxCleanupScheduler(repo, { ...config, batchSize: 1 });
      await scheduler.runOnce();
      expect(idsInStore()).toEqual([middle, newest]);

      await scheduler.runOnce();
      expect(idsInStore()).toEqual([newest]);

      expect(idsInStore()).not.toContain(oldest);
    });
  });

  describe('resilience', () => {
    it('reports 0 and keeps going when the repository throws', async () => {
      const failing: EventPublicationRepository = {
        ...repo,
        findCompleted: jest.fn().mockRejectedValue(new Error('database unreachable')),
      } as unknown as EventPublicationRepository;
      scheduler = new OutboxCleanupScheduler(failing, config);

      await expect(scheduler.runOnce()).resolves.toBe(0);
    });

    it('stop is idempotent and never rejects', async () => {
      scheduler = new OutboxCleanupScheduler(repo, config);
      scheduler.start();

      await expect(scheduler.stop()).resolves.toBeUndefined();
      await expect(scheduler.stop()).resolves.toBeUndefined();
    });
  });
});
