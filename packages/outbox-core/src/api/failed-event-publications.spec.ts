import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import type { EventPublication, NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';
import { ResubmissionOptions } from '../types/resubmission-options';

import { FailedEventPublications } from './failed-event-publications';

function newInput(overrides: Partial<NewEventPublication> = {}): NewEventPublication {
  return {
    listenerId: 'L',
    eventType: 'E',
    serializedEvent: '{}',
    ...overrides,
  };
}

async function createFailed(
  repo: InMemoryEventPublicationRepository,
  overrides: Partial<NewEventPublication> = {},
  opts: { attempts?: number } = {},
): Promise<EventPublication> {
  const [pub] = await repo.createAll([newInput(overrides)]);
  const attempts = opts.attempts ?? 1;
  for (let i = 0; i < attempts; i++) {
    await repo.updateStatus(pub!.id, PublicationStatus.FAILED, {
      incrementAttempts: true,
      failureReason: 'test',
    });
  }
  return pub!;
}

describe('FailedEventPublications', () => {
  let repo: InMemoryEventPublicationRepository;
  let api: FailedEventPublications;

  beforeEach(() => {
    repo = new InMemoryEventPublicationRepository();
    api = new FailedEventPublications(repo);
  });

  it('findAll returns every FAILED publication', async () => {
    await createFailed(repo, { listenerId: 'A' });
    await createFailed(repo, { listenerId: 'B' });

    const all = await api.findAll();

    expect(all).toHaveLength(2);
    expect(all.map((p) => p.listenerId).sort()).toEqual(['A', 'B']);
  });

  it('count matches the number of FAILED publications', async () => {
    expect(await api.count()).toBe(0);
    await createFailed(repo);
    await createFailed(repo);
    expect(await api.count()).toBe(2);
  });

  it('resubmit transitions FAILED → RESUBMITTED and returns the number transitioned', async () => {
    await createFailed(repo, { listenerId: 'A' });
    await createFailed(repo, { listenerId: 'B' });

    const resubmitted = await api.resubmit();

    expect(resubmitted).toBe(2);
    expect(await api.count()).toBe(0);
    const all = repo.getAll();
    expect(all.every((p) => p.status === PublicationStatus.RESUBMITTED)).toBe(true);
    expect(all.every((p) => p.lastResubmissionDate instanceof Date)).toBe(true);
  });

  it('resubmit respects batchSize', async () => {
    await createFailed(repo);
    await createFailed(repo);
    await createFailed(repo);

    const resubmitted = await api.resubmit(ResubmissionOptions.defaults().withBatchSize(2));

    expect(resubmitted).toBe(2);
    expect(await api.count()).toBe(1);
  });

  it('resubmit applies the filter predicate', async () => {
    await createFailed(repo, { listenerId: 'keep' });
    await createFailed(repo, { listenerId: 'skip' });

    const resubmitted = await api.resubmit(
      ResubmissionOptions.defaults().withFilter((p) => p.listenerId === 'keep'),
    );

    expect(resubmitted).toBe(1);
    const failed = await api.findAll();
    expect(failed).toHaveLength(1);
    expect(failed[0]!.listenerId).toBe('skip');
  });

  it('resubmit filters by maxCompletionAttempts', async () => {
    await createFailed(repo, { listenerId: 'one-attempt' }, { attempts: 1 });
    await createFailed(repo, { listenerId: 'three-attempts' }, { attempts: 3 });

    const resubmitted = await api.resubmit(ResubmissionOptions.defaults().withMaxAttempts(1));

    expect(resubmitted).toBe(1);
    // The three-attempts publication stays FAILED
    const stillFailed = await api.findAll();
    expect(stillFailed).toHaveLength(1);
    expect(stillFailed[0]!.listenerId).toBe('three-attempts');
  });

  it('findAll passes minAge / maxAttempts through to the repository', async () => {
    const old = new Date(Date.now() - 120_000);
    const recent = new Date(Date.now() - 1_000);
    await createFailed(repo, { listenerId: 'old', publicationDate: old });
    await createFailed(repo, { listenerId: 'recent', publicationDate: recent });

    const aged = await api.findAll({ minAge: 60_000 });

    expect(aged).toHaveLength(1);
    expect(aged[0]!.listenerId).toBe('old');
  });
});
