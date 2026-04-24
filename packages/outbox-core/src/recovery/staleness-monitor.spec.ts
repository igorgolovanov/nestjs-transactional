import { Logger } from '@nestjs/common';

import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import type { NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';
import type { StalenessConfig } from '../types/staleness-config';

import { StalenessMonitor } from './staleness-monitor';

function sampleInput(publicationDate: Date): NewEventPublication {
  return {
    listenerId: 'Inventory.onOrderPlaced',
    eventType: 'OrderPlacedEvent',
    serializedEvent: JSON.stringify({ orderId: 'order-1' }),
    publicationDate,
  };
}

const disabledConfig: StalenessConfig = {
  published: 0,
  processing: 0,
  resubmitted: 0,
  monitorInterval: 60_000,
};

describe('StalenessMonitor', () => {
  let repo: InMemoryEventPublicationRepository;
  let monitor: StalenessMonitor | undefined;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    repo = new InMemoryEventPublicationRepository();
  });

  afterEach(() => {
    monitor?.stop();
    monitor = undefined;
    jest.useRealTimers();
  });

  it('does not schedule the polling loop when every threshold is 0', () => {
    jest.useFakeTimers();
    monitor = new StalenessMonitor(repo, disabledConfig);

    monitor.start();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('schedules the polling loop when at least one threshold is > 0', () => {
    jest.useFakeTimers();
    monitor = new StalenessMonitor(repo, {
      ...disabledConfig,
      processing: 60_000,
    });

    monitor.start();

    expect(jest.getTimerCount()).toBe(1);
  });

  it('marks PUBLISHED publications older than the threshold as FAILED', async () => {
    const old = new Date(Date.now() - 60_000);
    const [pub] = await repo.createAll([sampleInput(old)]);

    monitor = new StalenessMonitor(repo, {
      ...disabledConfig,
      published: 10_000,
    });
    await monitor.checkStaleness();

    const updated = (await repo.findById(pub!.id))!;
    expect(updated.status).toBe(PublicationStatus.FAILED);
    expect(updated.failureReason).toMatch(/PUBLISHED/);
  });

  it('marks PROCESSING publications older than the threshold as FAILED', async () => {
    const old = new Date(Date.now() - 120_000);
    const [pub] = await repo.createAll([sampleInput(old)]);
    await repo.updateStatus(pub!.id, PublicationStatus.PROCESSING);

    monitor = new StalenessMonitor(repo, {
      ...disabledConfig,
      processing: 30_000,
    });
    await monitor.checkStaleness();

    const updated = (await repo.findById(pub!.id))!;
    expect(updated.status).toBe(PublicationStatus.FAILED);
    expect(updated.failureReason).toMatch(/PROCESSING/);
  });

  it('marks RESUBMITTED publications older than the threshold as FAILED', async () => {
    const old = new Date(Date.now() - 600_000);
    const [pub] = await repo.createAll([sampleInput(old)]);
    await repo.updateStatus(pub!.id, PublicationStatus.RESUBMITTED);

    monitor = new StalenessMonitor(repo, {
      ...disabledConfig,
      resubmitted: 60_000,
    });
    await monitor.checkStaleness();

    const updated = (await repo.findById(pub!.id))!;
    expect(updated.status).toBe(PublicationStatus.FAILED);
    expect(updated.failureReason).toMatch(/RESUBMITTED/);
  });

  it('leaves COMPLETED publications untouched even when every non-terminal threshold fires', async () => {
    const old = new Date(Date.now() - 600_000);
    const [pub] = await repo.createAll([sampleInput(old)]);
    await repo.updateStatus(pub!.id, PublicationStatus.COMPLETED);

    monitor = new StalenessMonitor(repo, {
      published: 1_000,
      processing: 1_000,
      resubmitted: 1_000,
      monitorInterval: 60_000,
    });
    await monitor.checkStaleness();

    expect((await repo.findById(pub!.id))!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('leaves publications younger than the threshold alone', async () => {
    const recent = new Date(Date.now() - 5_000);
    const [pub] = await repo.createAll([sampleInput(recent)]);
    await repo.updateStatus(pub!.id, PublicationStatus.PROCESSING);

    monitor = new StalenessMonitor(repo, {
      ...disabledConfig,
      processing: 60_000,
    });
    await monitor.checkStaleness();

    expect((await repo.findById(pub!.id))!.status).toBe(PublicationStatus.PROCESSING);
  });

  it('stop cancels the scheduled polling tick', () => {
    jest.useFakeTimers();
    monitor = new StalenessMonitor(repo, {
      ...disabledConfig,
      processing: 60_000,
    });

    monitor.start();
    expect(jest.getTimerCount()).toBe(1);

    monitor.stop();
    expect(jest.getTimerCount()).toBe(0);
  });
});
