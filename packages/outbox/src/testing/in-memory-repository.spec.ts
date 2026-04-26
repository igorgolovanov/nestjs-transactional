import { PublicationNotFoundError } from '../types/errors';
import type { NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';

import { InMemoryEventPublicationRepository } from './in-memory-repository';

function sampleInput(overrides: Partial<NewEventPublication> = {}): NewEventPublication {
  return {
    listenerId: 'Inventory.on(OrderPlacedEvent)',
    eventType: 'OrderPlacedEvent',
    serializedEvent: JSON.stringify({ orderId: 'order-1' }),
    ...overrides,
  };
}

describe('InMemoryEventPublicationRepository', () => {
  let repo: InMemoryEventPublicationRepository;

  beforeEach(() => {
    repo = new InMemoryEventPublicationRepository();
  });

  describe('createAll', () => {
    it('creates a publication with generated id, PUBLISHED status, zero attempts, and null completion/failure fields', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      expect(pub).toBeDefined();
      expect(pub!.id).toMatch(/^[0-9a-f]{8}-/);
      expect(pub!.status).toBe(PublicationStatus.PUBLISHED);
      expect(pub!.completionAttempts).toBe(0);
      expect(pub!.completionDate).toBeNull();
      expect(pub!.failureReason).toBeNull();
      expect(pub!.lastResubmissionDate).toBeNull();
    });

    it('uses the provided publicationDate when given', async () => {
      const when = new Date('2026-01-15T10:00:00Z');
      const [pub] = await repo.createAll([sampleInput({ publicationDate: when })]);

      expect(pub!.publicationDate).toBe(when);
    });

    it('defaults publicationDate to the current time when not provided', async () => {
      const before = Date.now();
      const [pub] = await repo.createAll([sampleInput()]);
      const after = Date.now();

      expect(pub!.publicationDate.getTime()).toBeGreaterThanOrEqual(before);
      expect(pub!.publicationDate.getTime()).toBeLessThanOrEqual(after);
    });

    it('creates several publications in a single call', async () => {
      const created = await repo.createAll([
        sampleInput({ listenerId: 'A' }),
        sampleInput({ listenerId: 'B' }),
        sampleInput({ listenerId: 'C' }),
      ]);

      expect(created).toHaveLength(3);
      expect(created.map((p) => p.listenerId)).toEqual(['A', 'B', 'C']);
      expect(repo.count()).toBe(3);
    });
  });

  describe('findById', () => {
    it('returns the publication when found', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      expect(await repo.findById(pub!.id)).toEqual(pub);
    });

    it('returns null when not found', async () => {
      expect(await repo.findById('unknown')).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('transitions a publication from PUBLISHED to PROCESSING', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      await repo.updateStatus(pub!.id, PublicationStatus.PROCESSING);

      expect((await repo.findById(pub!.id))!.status).toBe(PublicationStatus.PROCESSING);
    });

    it('sets completionDate when transitioning to COMPLETED', async () => {
      const [pub] = await repo.createAll([sampleInput()]);
      const completionDate = new Date('2026-02-01T12:00:00Z');

      await repo.updateStatus(pub!.id, PublicationStatus.COMPLETED, { completionDate });

      const updated = (await repo.findById(pub!.id))!;
      expect(updated.status).toBe(PublicationStatus.COMPLETED);
      expect(updated.completionDate).toBe(completionDate);
    });

    it('sets failureReason when transitioning to FAILED', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      await repo.updateStatus(pub!.id, PublicationStatus.FAILED, {
        failureReason: 'DB connection lost',
      });

      const updated = (await repo.findById(pub!.id))!;
      expect(updated.status).toBe(PublicationStatus.FAILED);
      expect(updated.failureReason).toBe('DB connection lost');
    });

    it('increments completionAttempts when incrementAttempts=true', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      await repo.updateStatus(pub!.id, PublicationStatus.PROCESSING, {
        incrementAttempts: true,
      });
      await repo.updateStatus(pub!.id, PublicationStatus.PROCESSING, {
        incrementAttempts: true,
      });

      expect((await repo.findById(pub!.id))!.completionAttempts).toBe(2);
    });

    it('does not increment completionAttempts by default', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      await repo.updateStatus(pub!.id, PublicationStatus.PROCESSING);

      expect((await repo.findById(pub!.id))!.completionAttempts).toBe(0);
    });

    it('sets lastResubmissionDate when provided', async () => {
      const [pub] = await repo.createAll([sampleInput()]);
      const resubmittedAt = new Date('2026-03-01T09:00:00Z');

      await repo.updateStatus(pub!.id, PublicationStatus.RESUBMITTED, {
        lastResubmissionDate: resubmittedAt,
      });

      expect((await repo.findById(pub!.id))!.lastResubmissionDate).toBe(resubmittedAt);
    });

    it('preserves existing fields not passed in options', async () => {
      const [pub] = await repo.createAll([sampleInput()]);
      await repo.updateStatus(pub!.id, PublicationStatus.FAILED, {
        failureReason: 'first',
      });

      await repo.updateStatus(pub!.id, PublicationStatus.RESUBMITTED);

      const updated = (await repo.findById(pub!.id))!;
      expect(updated.failureReason).toBe('first');
    });

    it('throws PublicationNotFoundError for an unknown id', async () => {
      await expect(
        repo.updateStatus('unknown', PublicationStatus.PROCESSING),
      ).rejects.toBeInstanceOf(PublicationNotFoundError);
    });
  });

  describe('tryClaim', () => {
    it('claims a PUBLISHED publication, transitions to PROCESSING, and increments attempts', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      const claimed = await repo.tryClaim(pub!.id);

      expect(claimed).toBe(true);
      const updated = (await repo.findById(pub!.id))!;
      expect(updated.status).toBe(PublicationStatus.PROCESSING);
      expect(updated.completionAttempts).toBe(1);
    });

    it('claims a RESUBMITTED publication', async () => {
      const [pub] = await repo.createAll([sampleInput()]);
      await repo.updateStatus(pub!.id, PublicationStatus.RESUBMITTED);

      expect(await repo.tryClaim(pub!.id)).toBe(true);
      expect((await repo.findById(pub!.id))!.status).toBe(PublicationStatus.PROCESSING);
    });

    it('is idempotent: a second claim on a PROCESSING publication returns false', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      const first = await repo.tryClaim(pub!.id);
      const second = await repo.tryClaim(pub!.id);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('refuses to claim COMPLETED or FAILED publications', async () => {
      const [completed] = await repo.createAll([sampleInput()]);
      const [failed] = await repo.createAll([sampleInput()]);
      await repo.updateStatus(completed!.id, PublicationStatus.COMPLETED);
      await repo.updateStatus(failed!.id, PublicationStatus.FAILED);

      expect(await repo.tryClaim(completed!.id)).toBe(false);
      expect(await repo.tryClaim(failed!.id)).toBe(false);
    });

    it('returns false for an unknown id', async () => {
      expect(await repo.tryClaim('unknown')).toBe(false);
    });
  });

  describe('findReadyForProcessing', () => {
    it('returns PUBLISHED and RESUBMITTED publications, ignoring others', async () => {
      const created = await repo.createAll([
        sampleInput({ listenerId: 'published' }),
        sampleInput({ listenerId: 'processing' }),
        sampleInput({ listenerId: 'completed' }),
        sampleInput({ listenerId: 'failed' }),
        sampleInput({ listenerId: 'resubmitted' }),
      ]);
      await repo.updateStatus(created[1]!.id, PublicationStatus.PROCESSING);
      await repo.updateStatus(created[2]!.id, PublicationStatus.COMPLETED);
      await repo.updateStatus(created[3]!.id, PublicationStatus.FAILED);
      await repo.updateStatus(created[4]!.id, PublicationStatus.RESUBMITTED);

      const ready = await repo.findReadyForProcessing(10);

      expect(ready.map((p) => p.listenerId).sort()).toEqual(['published', 'resubmitted']);
    });

    it('respects the limit', async () => {
      await repo.createAll([sampleInput(), sampleInput(), sampleInput()]);

      expect(await repo.findReadyForProcessing(2)).toHaveLength(2);
    });
  });

  describe('findStale', () => {
    it('filters by publicationDate strictly older than beforeDate and matching status', async () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-12-01T00:00:00Z');
      await repo.createAll([
        sampleInput({ listenerId: 'old-pub', publicationDate: old }),
        sampleInput({ listenerId: 'fresh-pub', publicationDate: fresh }),
      ]);

      const stale = await repo.findStale(new Date('2026-06-01T00:00:00Z'), [
        PublicationStatus.PUBLISHED,
      ]);

      expect(stale).toHaveLength(1);
      expect(stale[0]!.listenerId).toBe('old-pub');
    });

    it('filters out publications whose status is not in the requested list', async () => {
      const old = new Date('2026-01-01T00:00:00Z');
      const [pub] = await repo.createAll([sampleInput({ publicationDate: old })]);
      await repo.updateStatus(pub!.id, PublicationStatus.COMPLETED);

      const stale = await repo.findStale(new Date('2026-06-01T00:00:00Z'), [
        PublicationStatus.PUBLISHED,
        PublicationStatus.PROCESSING,
      ]);

      expect(stale).toHaveLength(0);
    });
  });

  describe('findCompleted', () => {
    it('returns only COMPLETED publications', async () => {
      const created = await repo.createAll([sampleInput(), sampleInput()]);
      await repo.updateStatus(created[0]!.id, PublicationStatus.COMPLETED);

      const completed = await repo.findCompleted();

      expect(completed).toHaveLength(1);
      expect(completed[0]!.id).toBe(created[0]!.id);
    });

    it('filters by olderThan against completionDate', async () => {
      const [pub] = await repo.createAll([sampleInput()]);
      await repo.updateStatus(pub!.id, PublicationStatus.COMPLETED, {
        completionDate: new Date('2026-01-01T00:00:00Z'),
      });

      const recent = await repo.findCompleted({ olderThan: new Date('2025-12-01T00:00:00Z') });
      const older = await repo.findCompleted({ olderThan: new Date('2026-06-01T00:00:00Z') });

      expect(recent).toHaveLength(0);
      expect(older).toHaveLength(1);
    });

    it('respects the limit', async () => {
      const created = await repo.createAll([sampleInput(), sampleInput(), sampleInput()]);
      for (const p of created) {
        await repo.updateStatus(p.id, PublicationStatus.COMPLETED);
      }

      expect(await repo.findCompleted({ limit: 2 })).toHaveLength(2);
    });
  });

  describe('findIncomplete', () => {
    it('returns every non-COMPLETED publication', async () => {
      const created = await repo.createAll([
        sampleInput({ listenerId: 'published' }),
        sampleInput({ listenerId: 'processing' }),
        sampleInput({ listenerId: 'failed' }),
        sampleInput({ listenerId: 'completed' }),
      ]);
      await repo.updateStatus(created[1]!.id, PublicationStatus.PROCESSING);
      await repo.updateStatus(created[2]!.id, PublicationStatus.FAILED);
      await repo.updateStatus(created[3]!.id, PublicationStatus.COMPLETED);

      const incomplete = await repo.findIncomplete();

      expect(incomplete.map((p) => p.listenerId).sort()).toEqual([
        'failed',
        'processing',
        'published',
      ]);
    });
  });

  describe('findFailed', () => {
    it('returns only FAILED publications', async () => {
      const created = await repo.createAll([sampleInput(), sampleInput()]);
      await repo.updateStatus(created[0]!.id, PublicationStatus.FAILED);

      const failed = await repo.findFailed();

      expect(failed).toHaveLength(1);
      expect(failed[0]!.id).toBe(created[0]!.id);
    });

    it('filters by minAge (ms since publicationDate)', async () => {
      const recent = new Date(Date.now() - 1_000);
      const old = new Date(Date.now() - 60_000);
      const created = await repo.createAll([
        sampleInput({ listenerId: 'recent', publicationDate: recent }),
        sampleInput({ listenerId: 'old', publicationDate: old }),
      ]);
      await repo.updateStatus(created[0]!.id, PublicationStatus.FAILED);
      await repo.updateStatus(created[1]!.id, PublicationStatus.FAILED);

      const aged = await repo.findFailed({ minAge: 30_000 });

      expect(aged).toHaveLength(1);
      expect(aged[0]!.listenerId).toBe('old');
    });

    it('filters by maxAttempts (inclusive)', async () => {
      const created = await repo.createAll([sampleInput(), sampleInput()]);
      await repo.updateStatus(created[0]!.id, PublicationStatus.FAILED, {
        incrementAttempts: true,
      });
      await repo.updateStatus(created[1]!.id, PublicationStatus.FAILED, {
        incrementAttempts: true,
      });
      await repo.updateStatus(created[1]!.id, PublicationStatus.FAILED, {
        incrementAttempts: true,
      });

      const limited = await repo.findFailed({ maxAttempts: 1 });

      expect(limited).toHaveLength(1);
      expect(limited[0]!.id).toBe(created[0]!.id);
    });
  });

  describe('deleteCompleted', () => {
    it('deletes every COMPLETED publication when olderThan is omitted', async () => {
      const created = await repo.createAll([sampleInput(), sampleInput(), sampleInput()]);
      await repo.updateStatus(created[0]!.id, PublicationStatus.COMPLETED);
      await repo.updateStatus(created[1]!.id, PublicationStatus.COMPLETED);

      const removed = await repo.deleteCompleted();

      expect(removed).toBe(2);
      expect(repo.count()).toBe(1);
    });

    it('deletes only COMPLETED publications whose completionDate is older than the threshold', async () => {
      const created = await repo.createAll([sampleInput(), sampleInput()]);
      await repo.updateStatus(created[0]!.id, PublicationStatus.COMPLETED, {
        completionDate: new Date('2026-01-01T00:00:00Z'),
      });
      await repo.updateStatus(created[1]!.id, PublicationStatus.COMPLETED, {
        completionDate: new Date('2026-12-01T00:00:00Z'),
      });

      const removed = await repo.deleteCompleted(new Date('2026-06-01T00:00:00Z'));

      expect(removed).toBe(1);
      const leftovers = await repo.findCompleted();
      expect(leftovers).toHaveLength(1);
    });

    it('does not delete non-COMPLETED publications', async () => {
      const created = await repo.createAll([sampleInput(), sampleInput()]);
      await repo.updateStatus(created[0]!.id, PublicationStatus.FAILED);
      await repo.updateStatus(created[1]!.id, PublicationStatus.PROCESSING);

      expect(await repo.deleteCompleted()).toBe(0);
      expect(repo.count()).toBe(2);
    });
  });

  describe('archiveCompleted', () => {
    it('removes the publication (in-memory has no separate archive)', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      await repo.archiveCompleted(pub!.id);

      expect(await repo.findById(pub!.id)).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the publication by id', async () => {
      const [pub] = await repo.createAll([sampleInput()]);

      await repo.delete(pub!.id);

      expect(await repo.findById(pub!.id)).toBeNull();
    });
  });

  describe('testing helpers', () => {
    it('reset clears all publications', async () => {
      await repo.createAll([sampleInput(), sampleInput()]);

      repo.reset();

      expect(repo.count()).toBe(0);
    });

    it('getAll returns an array of all publications', async () => {
      await repo.createAll([sampleInput(), sampleInput()]);

      expect(repo.getAll()).toHaveLength(2);
    });
  });
});
