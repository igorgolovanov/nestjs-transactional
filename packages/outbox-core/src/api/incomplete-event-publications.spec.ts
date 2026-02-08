import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import type { NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';
import { ResubmissionOptions } from '../types/resubmission-options';

import { IncompleteEventPublications } from './incomplete-event-publications';

function newInput(overrides: Partial<NewEventPublication> = {}): NewEventPublication {
  return {
    listenerId: 'L',
    eventType: 'E',
    serializedEvent: '{}',
    ...overrides,
  };
}

describe('IncompleteEventPublications', () => {
  let repo: InMemoryEventPublicationRepository;
  let api: IncompleteEventPublications;

  beforeEach(() => {
    repo = new InMemoryEventPublicationRepository();
    api = new IncompleteEventPublications(repo);
  });

  it('findAll returns every publication that is not COMPLETED', async () => {
    const [published, processing, failed, completed] = await repo.createAll([
      newInput({ listenerId: 'published' }),
      newInput({ listenerId: 'processing' }),
      newInput({ listenerId: 'failed' }),
      newInput({ listenerId: 'completed' }),
    ]);
    await repo.updateStatus(processing!.id, PublicationStatus.PROCESSING);
    await repo.updateStatus(failed!.id, PublicationStatus.FAILED);
    await repo.updateStatus(completed!.id, PublicationStatus.COMPLETED);

    const incomplete = await api.findAll();

    expect(incomplete.map((p) => p.listenerId).sort()).toEqual(['failed', 'processing', 'published']);
    expect(incomplete.map((p) => p.id)).not.toContain(completed!.id);
    // silence unused-variable warnings for destructured pubs we do not touch further
    void published;
  });

  it('count matches the size of findAll', async () => {
    const [pub1, pub2, pub3] = await repo.createAll([newInput(), newInput(), newInput()]);
    await repo.updateStatus(pub1!.id, PublicationStatus.COMPLETED);
    void pub2;
    void pub3;

    expect(await api.count()).toBe(2);
  });

  it('resubmitIncompletePublications transitions FAILED and PUBLISHED to RESUBMITTED', async () => {
    const [published, failed] = await repo.createAll([
      newInput({ listenerId: 'published' }),
      newInput({ listenerId: 'failed' }),
    ]);
    await repo.updateStatus(failed!.id, PublicationStatus.FAILED);

    const resubmitted = await api.resubmitIncompletePublications();

    expect(resubmitted).toBe(2);
    expect((await repo.findById(published!.id))!.status).toBe(PublicationStatus.RESUBMITTED);
    expect((await repo.findById(failed!.id))!.status).toBe(PublicationStatus.RESUBMITTED);
  });

  it('leaves PROCESSING and already-RESUBMITTED publications untouched', async () => {
    const [processing, resubmitted] = await repo.createAll([
      newInput({ listenerId: 'processing' }),
      newInput({ listenerId: 'resubmitted' }),
    ]);
    await repo.updateStatus(processing!.id, PublicationStatus.PROCESSING);
    await repo.updateStatus(resubmitted!.id, PublicationStatus.RESUBMITTED);
    const originalResubmissionDate = (await repo.findById(resubmitted!.id))!.lastResubmissionDate;

    const touched = await api.resubmitIncompletePublications();

    expect(touched).toBe(0);
    expect((await repo.findById(processing!.id))!.status).toBe(PublicationStatus.PROCESSING);
    const resubmittedAfter = (await repo.findById(resubmitted!.id))!;
    expect(resubmittedAfter.status).toBe(PublicationStatus.RESUBMITTED);
    expect(resubmittedAfter.lastResubmissionDate).toBe(originalResubmissionDate);
  });

  it('respects batchSize', async () => {
    await repo.createAll([newInput(), newInput(), newInput()]);

    const resubmitted = await api.resubmitIncompletePublications(
      ResubmissionOptions.defaults().withBatchSize(2),
    );

    expect(resubmitted).toBe(2);
  });

  it('respects the filter predicate', async () => {
    await repo.createAll([
      newInput({ listenerId: 'keep' }),
      newInput({ listenerId: 'skip' }),
    ]);

    const resubmitted = await api.resubmitIncompletePublications(
      ResubmissionOptions.defaults().withFilter((p) => p.listenerId === 'keep'),
    );

    expect(resubmitted).toBe(1);
  });
});
