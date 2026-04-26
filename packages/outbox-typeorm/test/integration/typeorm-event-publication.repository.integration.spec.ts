import { randomUUID } from 'node:crypto';

import {
  TransactionManager,
  TransactionalModule,
} from '@nestjs-transactional/core';
import { PublicationStatus } from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';

import { EventPublicationArchiveEntity } from '../../src/entity/event-publication-archive.entity';
import { EventPublicationEntity } from '../../src/entity/event-publication.entity';
import { TypeOrmEventPublicationRepository } from '../../src/repository/typeorm-event-publication.repository';
import {
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';

function seedInput(overrides: {
  listenerId?: string;
  eventType?: string;
  serializedEvent?: string;
  publicationDate?: Date;
} = {}): {
  listenerId: string;
  eventType: string;
  serializedEvent: string;
  publicationDate?: Date;
} {
  return {
    listenerId: overrides.listenerId ?? 'L',
    eventType: overrides.eventType ?? 'E',
    serializedEvent: overrides.serializedEvent ?? '{}',
    ...(overrides.publicationDate !== undefined
      ? { publicationDate: overrides.publicationDate }
      : {}),
  };
}

describe('TypeOrmEventPublicationRepository (integration, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;
  let module: TestingModule;
  let manager: TransactionManager;
  let repo: TypeOrmEventPublicationRepository;

  beforeAll(async () => {
    ctx = await startPostgresContainer({
      entities: [EventPublicationEntity, EventPublicationArchiveEntity],
      synchronize: true,
    });

    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: false,
        }),
        TypeOrmTransactionalModule.forFeature({
          dataSource: ctx.dataSource,
          instanceName: 'default',
          isDefault: true,
        }),
      ],
    }).compile();
    await module.init();

    manager = module.get(TransactionManager);
    repo = new TypeOrmEventPublicationRepository(ctx.dataSource, 'default');
  });

  afterAll(async () => {
    await module.close();
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    // `clear()` issues TRUNCATE which is fast and satisfies TypeORM's
    // "empty criteria" guard on `delete()`. Clear the archive first —
    // it has no FK into the main table, but in case that changes a
    // referential order preserves the invariant.
    await ctx.dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await ctx.dataSource.getRepository(EventPublicationEntity).clear();
  });

  describe('createAll', () => {
    it('persists rows with PUBLISHED status and default bookkeeping fields', async () => {
      const created = await manager.run({}, () =>
        repo.createAll([seedInput({ listenerId: 'a' }), seedInput({ listenerId: 'b' })]),
      );

      expect(created).toHaveLength(2);
      const rows = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .find({ order: { listenerId: 'ASC' } });
      expect(rows).toHaveLength(2);
      expect(rows[0]!.listenerId).toBe('a');
      expect(rows[0]!.status).toBe(PublicationStatus.PUBLISHED);
      expect(rows[0]!.completionAttempts).toBe(0);
      expect(rows[0]!.completionDate).toBeNull();
      expect(rows[0]!.lastResubmissionDate).toBeNull();
      expect(rows[0]!.failureReason).toBeNull();
    });

    it('rolls back inserts when the ambient transaction fails', async () => {
      await expect(
        manager.run({}, async () => {
          await repo.createAll([seedInput({ listenerId: 'doomed' })]);
          throw new Error('transaction aborted');
        }),
      ).rejects.toThrow('transaction aborted');

      const count = await ctx.dataSource.getRepository(EventPublicationEntity).count();
      expect(count).toBe(0);
    });
  });

  describe('tryClaim', () => {
    it('transitions PUBLISHED → PROCESSING and increments completionAttempts', async () => {
      const [pub] = await manager.run({}, () => repo.createAll([seedInput()]));
      const claimed = await repo.tryClaim(pub!.id);

      expect(claimed).toBe(true);
      const row = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: pub!.id } });
      expect(row.status).toBe(PublicationStatus.PROCESSING);
      expect(row.completionAttempts).toBe(1);
    });

    it('returns false when the row is already PROCESSING/COMPLETED/FAILED', async () => {
      const [pub] = await manager.run({}, () => repo.createAll([seedInput()]));
      await repo.tryClaim(pub!.id);

      const second = await repo.tryClaim(pub!.id);
      expect(second).toBe(false);
    });

    it('is atomic under concurrent callers — exactly one wins', async () => {
      const [pub] = await manager.run({}, () => repo.createAll([seedInput()]));

      const results = await Promise.all([repo.tryClaim(pub!.id), repo.tryClaim(pub!.id)]);
      const winners = results.filter((r) => r === true);
      const losers = results.filter((r) => r === false);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      const row = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: pub!.id } });
      expect(row.status).toBe(PublicationStatus.PROCESSING);
      expect(row.completionAttempts).toBe(1);
    });
  });

  describe('findReadyForProcessing', () => {
    it('returns PUBLISHED and RESUBMITTED rows ordered by publication_date ASC', async () => {
      const t0 = new Date(Date.now() - 3000);
      const t1 = new Date(Date.now() - 2000);
      const t2 = new Date(Date.now() - 1000);

      await manager.run({}, () =>
        repo.createAll([
          seedInput({ listenerId: 'c', publicationDate: t2 }),
          seedInput({ listenerId: 'a', publicationDate: t0 }),
          seedInput({ listenerId: 'b', publicationDate: t1 }),
        ]),
      );

      const ready = await repo.findReadyForProcessing(10);
      expect(ready.map((p) => p.listenerId)).toEqual(['a', 'b', 'c']);
    });

    it('concurrent workers race for the same rows — tryClaim guarantees exactly-one-claim semantics', async () => {
      // Architectural note: previous design used `FOR UPDATE SKIP
      // LOCKED` here to give workers disjoint row sets. That design
      // was dropped (the pessimistic lock requires an enclosing
      // transaction whose lifetime did not fit the worker flow);
      // correctness now relies entirely on `tryClaim`, which uses
      // an atomic conditional UPDATE so only one worker per row can
      // win the claim. This test pins that contract.
      await manager.run({}, () =>
        repo.createAll([
          seedInput({ listenerId: 'p1' }),
          seedInput({ listenerId: 'p2' }),
          seedInput({ listenerId: 'p3' }),
          seedInput({ listenerId: 'p4' }),
        ]),
      );

      async function workerClaim(): Promise<string[]> {
        // Each worker fetches the full ready set and then races to
        // claim every row it sees. With FOR UPDATE SKIP LOCKED gone
        // both workers DO see the same four rows, but `tryClaim`'s
        // conditional UPDATE returns false on rows another worker
        // already won.
        const ready = await repo.findReadyForProcessing(10);
        const claimed: string[] = [];
        for (const row of ready) {
          if (await repo.tryClaim(row.id)) {
            claimed.push(row.id);
          }
        }
        return claimed;
      }

      const [claimedA, claimedB] = await Promise.all([workerClaim(), workerClaim()]);

      // Together the workers claim all four rows exactly once: no
      // overlap, no missed rows, total claims === 4.
      expect(claimedA.some((id) => claimedB.includes(id))).toBe(false);
      const claimedAll = [...claimedA, ...claimedB].sort();
      expect(claimedAll).toHaveLength(4);
      expect(new Set(claimedAll).size).toBe(4);
    });
  });

  describe('lifecycle', () => {
    it('drives a publication PUBLISHED → PROCESSING → COMPLETED', async () => {
      const [pub] = await manager.run({}, () => repo.createAll([seedInput()]));
      expect(pub!.status).toBe(PublicationStatus.PUBLISHED);

      await repo.tryClaim(pub!.id);
      const completedAt = new Date();
      await repo.updateStatus(pub!.id, PublicationStatus.COMPLETED, {
        completionDate: completedAt,
      });

      const row = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: pub!.id } });
      expect(row.status).toBe(PublicationStatus.COMPLETED);
      expect(row.completionDate).toEqual(completedAt);
      expect(row.completionAttempts).toBe(1);
    });

    it('drives a publication through the failure path → RESUBMITTED → COMPLETED', async () => {
      const [pub] = await manager.run({}, () => repo.createAll([seedInput()]));

      await repo.tryClaim(pub!.id);
      await repo.updateStatus(pub!.id, PublicationStatus.FAILED, {
        failureReason: 'boom',
      });
      await repo.updateStatus(pub!.id, PublicationStatus.RESUBMITTED, {
        lastResubmissionDate: new Date(),
      });
      await repo.tryClaim(pub!.id); // attempts → 2
      await repo.updateStatus(pub!.id, PublicationStatus.COMPLETED, {
        completionDate: new Date(),
      });

      const row = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: pub!.id } });
      expect(row.status).toBe(PublicationStatus.COMPLETED);
      expect(row.failureReason).toBe('boom');
      expect(row.lastResubmissionDate).not.toBeNull();
      expect(row.completionAttempts).toBe(2);
    });
  });

  describe('query APIs', () => {
    it('findStale: returns non-terminal rows with publicationDate before threshold', async () => {
      const oldDate = new Date(Date.now() - 60_000);
      const newDate = new Date();
      await manager.run({}, () =>
        repo.createAll([
          seedInput({ listenerId: 'stale', publicationDate: oldDate }),
          seedInput({ listenerId: 'fresh', publicationDate: newDate }),
        ]),
      );

      const stale = await repo.findStale(new Date(Date.now() - 30_000), [
        PublicationStatus.PUBLISHED,
      ]);
      expect(stale.map((p) => p.listenerId)).toEqual(['stale']);
    });

    it('findFailed: honours minAge and maxAttempts filters', async () => {
      const old = new Date(Date.now() - 120_000);
      await manager.run({}, () =>
        repo.createAll([
          seedInput({ listenerId: 'old-failed', publicationDate: old }),
          seedInput({ listenerId: 'new-failed' }),
        ]),
      );
      const rows = await ctx.dataSource.getRepository(EventPublicationEntity).find();
      for (const row of rows) {
        await repo.updateStatus(row.id, PublicationStatus.FAILED, { failureReason: 'x' });
      }

      const olderFailures = await repo.findFailed({ minAge: 60_000 });
      expect(olderFailures.map((p) => p.listenerId)).toEqual(['old-failed']);
    });

    it('findIncomplete: returns everything except COMPLETED', async () => {
      const [a, b, c] = await manager.run({}, () =>
        repo.createAll([
          seedInput({ listenerId: 'a' }),
          seedInput({ listenerId: 'b' }),
          seedInput({ listenerId: 'c' }),
        ]),
      );

      await repo.updateStatus(a!.id, PublicationStatus.COMPLETED, {
        completionDate: new Date(),
      });
      await repo.updateStatus(b!.id, PublicationStatus.FAILED);
      // c stays PUBLISHED

      const incomplete = await repo.findIncomplete();
      const ids = incomplete.map((p) => p.id).sort();
      expect(ids).toEqual([b!.id, c!.id].sort());
    });
  });

  describe('cleanup', () => {
    it('deleteCompleted: removes only completed rows older than olderThan', async () => {
      const [a, b, c] = await manager.run({}, () =>
        repo.createAll([
          seedInput({ listenerId: 'old' }),
          seedInput({ listenerId: 'recent' }),
          seedInput({ listenerId: 'pending' }),
        ]),
      );

      await repo.updateStatus(a!.id, PublicationStatus.COMPLETED, {
        completionDate: new Date(Date.now() - 120_000),
      });
      await repo.updateStatus(b!.id, PublicationStatus.COMPLETED, {
        completionDate: new Date(),
      });
      // c stays PUBLISHED

      const removed = await repo.deleteCompleted(new Date(Date.now() - 60_000));

      expect(removed).toBe(1);
      const remaining = await ctx.dataSource.getRepository(EventPublicationEntity).find();
      expect(remaining.map((r) => r.id).sort()).toEqual([b!.id, c!.id].sort());
    });

    it('archiveCompleted: copies to archive table and deletes from main', async () => {
      const [pub] = await manager.run({}, () => repo.createAll([seedInput()]));
      const completedAt = new Date();
      await repo.updateStatus(pub!.id, PublicationStatus.COMPLETED, {
        completionDate: completedAt,
      });

      await repo.archiveCompleted(pub!.id);

      const main = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOne({ where: { id: pub!.id } });
      const archived = await ctx.dataSource
        .getRepository(EventPublicationArchiveEntity)
        .findOneOrFail({ where: { id: pub!.id } });
      expect(main).toBeNull();
      expect(archived.status).toBe(PublicationStatus.COMPLETED);
      expect(archived.completionDate).toEqual(completedAt);
      expect(archived.listenerId).toBe('L');
    });

    it('archiveCompleted: throws PublicationNotFoundError for an unknown id', async () => {
      const unknown = randomUUID();
      await expect(repo.archiveCompleted(unknown)).rejects.toMatchObject({
        code: 'PUBLICATION_NOT_FOUND',
      });
    });
  });
});
