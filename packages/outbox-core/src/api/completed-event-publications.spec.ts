import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import type { NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';

import { CompletedEventPublications } from './completed-event-publications';

function newInput(overrides: Partial<NewEventPublication> = {}): NewEventPublication {
  return {
    listenerId: 'L',
    eventType: 'E',
    serializedEvent: '{}',
    ...overrides,
  };
}

describe('CompletedEventPublications', () => {
  let repo: InMemoryEventPublicationRepository;
  let api: CompletedEventPublications;

  beforeEach(() => {
    repo = new InMemoryEventPublicationRepository();
    api = new CompletedEventPublications(repo);
  });

  it('findAll returns only COMPLETED publications', async () => {
    const [completed, failed] = await repo.createAll([newInput(), newInput()]);
    await repo.updateStatus(completed!.id, PublicationStatus.COMPLETED);
    await repo.updateStatus(failed!.id, PublicationStatus.FAILED);

    const result = await api.findAll();

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(completed!.id);
  });

  it('count matches the number of COMPLETED publications', async () => {
    const [a, b] = await repo.createAll([newInput(), newInput()]);
    await repo.updateStatus(a!.id, PublicationStatus.COMPLETED);

    expect(await api.count()).toBe(1);

    await repo.updateStatus(b!.id, PublicationStatus.COMPLETED);
    expect(await api.count()).toBe(2);
  });

  it('findAll honours olderThan and limit', async () => {
    const [a, b, c] = await repo.createAll([newInput(), newInput(), newInput()]);
    await repo.updateStatus(a!.id, PublicationStatus.COMPLETED, {
      completionDate: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.updateStatus(b!.id, PublicationStatus.COMPLETED, {
      completionDate: new Date('2026-06-01T00:00:00Z'),
    });
    await repo.updateStatus(c!.id, PublicationStatus.COMPLETED, {
      completionDate: new Date('2026-12-01T00:00:00Z'),
    });

    const old = await api.findAll({ olderThan: new Date('2026-07-01T00:00:00Z') });
    expect(old).toHaveLength(2);

    const capped = await api.findAll({ limit: 1 });
    expect(capped).toHaveLength(1);
  });

  it('purge removes all COMPLETED publications when olderThan is omitted', async () => {
    const [a, b, c] = await repo.createAll([newInput(), newInput(), newInput()]);
    await repo.updateStatus(a!.id, PublicationStatus.COMPLETED);
    await repo.updateStatus(b!.id, PublicationStatus.COMPLETED);
    await repo.updateStatus(c!.id, PublicationStatus.FAILED);

    const removed = await api.purge();

    expect(removed).toBe(2);
    expect(await api.count()).toBe(0);
    // The FAILED publication is left alone
    expect(repo.count()).toBe(1);
  });

  it('purge with olderThan leaves recent publications alone', async () => {
    const [old, recent] = await repo.createAll([newInput(), newInput()]);
    await repo.updateStatus(old!.id, PublicationStatus.COMPLETED, {
      completionDate: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.updateStatus(recent!.id, PublicationStatus.COMPLETED, {
      completionDate: new Date('2026-12-01T00:00:00Z'),
    });

    const removed = await api.purge(new Date('2026-06-01T00:00:00Z'));

    expect(removed).toBe(1);
    const leftovers = await api.findAll();
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]!.id).toBe(recent!.id);
  });

  it('purge returns 0 when no COMPLETED publications match the cutoff', async () => {
    const [pub] = await repo.createAll([newInput()]);
    await repo.updateStatus(pub!.id, PublicationStatus.COMPLETED, {
      completionDate: new Date('2026-12-01T00:00:00Z'),
    });

    const removed = await api.purge(new Date('2026-06-01T00:00:00Z'));

    expect(removed).toBe(0);
    expect(await api.count()).toBe(1);
  });
});
