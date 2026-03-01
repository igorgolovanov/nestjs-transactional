import { Logger } from '@nestjs/common';

import { IncompleteEventPublications } from '../api/incomplete-event-publications';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import type { NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';

import {
  type OutboxRecoveryOptions,
  StartupRecoveryService,
} from './startup-recovery';

function newInput(overrides: Partial<NewEventPublication> = {}): NewEventPublication {
  return {
    listenerId: 'L',
    eventType: 'E',
    serializedEvent: '{}',
    ...overrides,
  };
}

describe('StartupRecoveryService', () => {
  let repo: InMemoryEventPublicationRepository;
  let incomplete: IncompleteEventPublications;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    repo = new InMemoryEventPublicationRepository();
    incomplete = new IncompleteEventPublications(repo);
  });

  async function seedOneFailed(): Promise<void> {
    const [pub] = await repo.createAll([newInput()]);
    await repo.updateStatus(pub!.id, PublicationStatus.FAILED);
  }

  it('is a no-op when republishOnStartup is false', async () => {
    await seedOneFailed();
    const service = new StartupRecoveryService(incomplete, {
      republishOnStartup: false,
    });

    await service.onApplicationBootstrap();

    expect((await repo.findById(repo.getAll()[0]!.id))!.status).toBe(PublicationStatus.FAILED);
  });

  it('resubmits every incomplete publication when republishOnStartup is true', async () => {
    const [published, failed] = await repo.createAll([
      newInput({ listenerId: 'published' }),
      newInput({ listenerId: 'failed' }),
    ]);
    await repo.updateStatus(failed!.id, PublicationStatus.FAILED);

    const service = new StartupRecoveryService(incomplete, {
      republishOnStartup: true,
    });

    await service.onApplicationBootstrap();

    expect((await repo.findById(published!.id))!.status).toBe(PublicationStatus.RESUBMITTED);
    expect((await repo.findById(failed!.id))!.status).toBe(PublicationStatus.RESUBMITTED);
  });

  it('respects startupBatchSize when more incomplete publications exist than the cap', async () => {
    const created = await repo.createAll([
      newInput({ listenerId: 'a' }),
      newInput({ listenerId: 'b' }),
      newInput({ listenerId: 'c' }),
    ]);
    for (const p of created) {
      await repo.updateStatus(p.id, PublicationStatus.FAILED);
    }

    const service = new StartupRecoveryService(incomplete, {
      republishOnStartup: true,
      startupBatchSize: 2,
    });

    await service.onApplicationBootstrap();

    const states = (await Promise.all(created.map((p) => repo.findById(p.id)))).map(
      (p) => p!.status,
    );
    const resubmittedCount = states.filter((s) => s === PublicationStatus.RESUBMITTED).length;
    expect(resubmittedCount).toBe(2);
  });

  it('defaults startupBatchSize to 1000 when omitted', async () => {
    const options: OutboxRecoveryOptions = { republishOnStartup: true };
    const resubmitSpy = jest.spyOn(incomplete, 'resubmitIncompletePublications');

    const service = new StartupRecoveryService(incomplete, options);
    await service.onApplicationBootstrap();

    const call = resubmitSpy.mock.calls[0]?.[0];
    expect(call?.batchSize).toBe(1000);
  });
});
