import { jest } from '@jest/globals';
import { PublicationNotFoundError, PublicationStatus } from '@nestjs-transactional/outbox';
import type { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import type { EventPublicationArchiveEntity as ArchiveEntityType } from '../../src/entity/event-publication-archive.entity.js';
import type { EventPublicationEntity as EntityType } from '../../src/entity/event-publication.entity.js';
import type { TypeOrmEventPublicationRepository as RepositoryType } from '../../src/repository/typeorm-event-publication.repository.js';

// `jest.mock` does not work under ESM: it relies on being hoisted above
// the imports, and ESM imports are resolved before any module code runs.
// `unstable_mockModule` is the supported replacement, and it requires the
// mocked module's consumers to be pulled in with dynamic `import()`
// afterwards — hence the top-level awaits below. The name is Jest's, not
// a comment on its reliability; it is the only module-mocking API ESM
// has.
jest.unstable_mockModule('@nestjs-transactional/typeorm', () => ({
  getCurrentEntityManager: jest.fn(),
}));

const { getCurrentEntityManager: getEntityManagerMock } =
  (await import('@nestjs-transactional/typeorm')) as unknown as {
    getCurrentEntityManager: jest.MockedFunction<typeof getCurrentEntityManager>;
  };

const { EventPublicationArchiveEntity } =
  await import('../../src/entity/event-publication-archive.entity.js');
const { EventPublicationEntity } = await import('../../src/entity/event-publication.entity.js');
const { TypeOrmEventPublicationRepository } =
  await import('../../src/repository/typeorm-event-publication.repository.js');

/**
 * Docker-free companion to
 * `test/integration/typeorm-event-publication.repository.integration.spec.ts`.
 *
 * The integration suite proves the SQL is correct against real Postgres.
 * These specs cover the decisions the repository makes *around* the SQL —
 * the `affected`-count interpretation that DD-025's claim contract rests
 * on, the guard branches that skip the database entirely, and the
 * entity → domain mapping — none of which need a database to pin.
 */
// `@jest/globals` types a bare `jest.fn()` as `UnknownFunction`, and
// `mockResolvedValue` / `mockReturnValue` then reject their argument.
// These stand in for TypeORM methods that are cast to the real interface
// anyway, so a permissive signature carrying the resolved type is enough
// to keep the assertions checked.
function asyncMock<T>(value: T) {
  return jest.fn<(...args: unknown[]) => Promise<T>>().mockResolvedValue(value);
}

describe('TypeOrmEventPublicationRepository (unit)', () => {
  /** Chainable stand-in for TypeORM's `UpdateQueryBuilder`. */
  function updateQueryBuilder(result: { affected?: number | null }) {
    return {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: asyncMock(result),
    };
  }

  function entityManager(overrides: Partial<Record<keyof EntityManager, unknown>> = {}) {
    const em = { ...overrides } as unknown as EntityManager;
    getEntityManagerMock.mockReturnValue(em);
    return em;
  }

  function repository(): RepositoryType {
    return new TypeOrmEventPublicationRepository({} as DataSource, 'default');
  }

  function entity(overrides: Partial<EntityType> = {}): EntityType {
    const e = new EventPublicationEntity();
    e.id = 'pub-1';
    e.listenerId = 'OrderPlacedHandler';
    e.eventType = 'OrderPlaced';
    e.serializedEvent = '{"orderId":"o-1"}';
    e.publicationDate = new Date('2020-01-01T00:00:00.000Z');
    e.status = PublicationStatus.PUBLISHED;
    e.completionDate = null;
    e.lastResubmissionDate = null;
    e.completionAttempts = 0;
    e.failureReason = null;
    return Object.assign(e, overrides);
  }

  describe('tryClaim — the DD-025 concurrency contract', () => {
    // `tryClaim` is the SPI's entire concurrency guarantee: it must report
    // whether THIS caller won the claim. Everything below pins the
    // translation from TypeORM's `affected` count to that boolean, because
    // a wrong answer here means either a duplicate dispatch (false
    // positive) or a publication nobody ever processes (false negative).

    it('reports a won claim when the conditional UPDATE affected the row', async () => {
      entityManager({ createQueryBuilder: () => updateQueryBuilder({ affected: 1 }) });

      await expect(repository().tryClaim('pub-1')).resolves.toBe(true);
    });

    it('reports a lost claim when the row no longer matched the status filter', async () => {
      entityManager({ createQueryBuilder: () => updateQueryBuilder({ affected: 0 }) });

      await expect(repository().tryClaim('pub-1')).resolves.toBe(false);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])(
      'treats an %s affected-count as a lost claim rather than a won one',
      async (_label, affected) => {
        // Drivers that do not report affected-row counts must not be read
        // as success — that would let every worker dispatch the same
        // publication.
        entityManager({
          createQueryBuilder: () => updateQueryBuilder({ affected }),
        });

        await expect(repository().tryClaim('pub-1')).resolves.toBe(false);
      },
    );

    it('constrains the UPDATE to claimable statuses', async () => {
      const qb = updateQueryBuilder({ affected: 1 });
      entityManager({ createQueryBuilder: () => qb });

      await repository().tryClaim('pub-1');

      expect(qb.where).toHaveBeenCalledWith(expect.stringContaining('status IN'), {
        id: 'pub-1',
        statuses: [PublicationStatus.PUBLISHED, PublicationStatus.RESUBMITTED],
      });
    });
  });

  describe('deleteCompleted', () => {
    it('returns the number of purged rows', async () => {
      entityManager({ delete: asyncMock({ affected: 7 }) });

      await expect(repository().deleteCompleted()).resolves.toBe(7);
    });

    it('reports zero when the driver omits the affected count', async () => {
      entityManager({ delete: asyncMock({ affected: null }) });

      await expect(repository().deleteCompleted()).resolves.toBe(0);
    });
  });

  describe('findStale', () => {
    it('short-circuits an empty status list without querying', async () => {
      const find = jest.fn();
      entityManager({ find });

      await expect(repository().findStale(new Date(), [])).resolves.toEqual([]);
      expect(find).not.toHaveBeenCalled();
    });

    it('queries when at least one status is requested', async () => {
      const find = asyncMock([entity()]);
      entityManager({ find });

      const result = await repository().findStale(new Date(), [PublicationStatus.PROCESSING]);

      expect(find).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });
  });

  describe('findCompleted', () => {
    // The retention scheduler reads through this method with a `limit`,
    // which is what turns the ordering into a correctness property: a
    // bounded pass reading newest-first would delete only recent rows
    // and never reach the old ones. Nothing pinned any of it before.

    it('orders oldest-first, which the SPI documents as the contract', async () => {
      const find = asyncMock([entity()]);
      entityManager({ find });

      await repository().findCompleted();

      expect(find).toHaveBeenCalledWith(
        EventPublicationEntity,
        expect.objectContaining({ order: { completionDate: 'ASC' } }),
      );
    });

    it('filters on COMPLETED and adds no date predicate when olderThan is omitted', async () => {
      const find = asyncMock([]);
      entityManager({ find });

      await repository().findCompleted();

      const [, options] = find.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
      expect(options.where).toEqual({ status: PublicationStatus.COMPLETED });
    });

    it('constrains completionDate when olderThan is given', async () => {
      const find = asyncMock([]);
      entityManager({ find });
      const cutoff = new Date('2020-03-03T00:00:00.000Z');

      await repository().findCompleted({ olderThan: cutoff });

      const [, options] = find.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
      expect(options.where.completionDate).toBeDefined();
      expect(options.where.status).toBe(PublicationStatus.COMPLETED);
    });

    it('passes limit through as take, and omits take entirely without one', async () => {
      const withLimit = asyncMock([]);
      entityManager({ find: withLimit });
      await repository().findCompleted({ limit: 25 });
      const [, limited] = withLimit.mock.calls[0] as [unknown, { take?: number }];
      expect(limited.take).toBe(25);

      const withoutLimit = asyncMock([]);
      entityManager({ find: withoutLimit });
      await repository().findCompleted();
      const [, unlimited] = withoutLimit.mock.calls[0] as [unknown, { take?: number }];
      expect(unlimited.take).toBeUndefined();
    });

    it('maps entities to the domain shape', async () => {
      entityManager({ find: asyncMock([entity({ status: PublicationStatus.COMPLETED })]) });

      const result = await repository().findCompleted();

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('pub-1');
      expect(result[0]?.status).toBe(PublicationStatus.COMPLETED);
    });
  });

  describe('archiveCompleted', () => {
    it('rejects with PublicationNotFoundError when the row is gone', async () => {
      entityManager({ findOne: asyncMock(null) });

      await expect(repository().archiveCompleted('missing')).rejects.toThrow(
        PublicationNotFoundError,
      );
    });

    it('copies the row into the archive and then removes it from the hot queue', async () => {
      const save = asyncMock(undefined);
      const del = asyncMock({ affected: 1 });
      const completionDate = new Date('2020-02-02T00:00:00.000Z');
      entityManager({
        findOne: asyncMock(entity({ status: PublicationStatus.COMPLETED, completionDate })),
        save,
        delete: del,
      });

      await repository().archiveCompleted('pub-1');

      expect(save).toHaveBeenCalledWith(
        EventPublicationArchiveEntity,
        expect.objectContaining({
          id: 'pub-1',
          listenerId: 'OrderPlacedHandler',
          eventType: 'OrderPlaced',
          status: PublicationStatus.COMPLETED,
          completionDate,
        }),
      );
      expect(del).toHaveBeenCalledWith(EventPublicationEntity, { id: 'pub-1' });
    });

    it('stamps a completion date when the archived row never carried one', async () => {
      // The archive table's `completionDate` is non-nullable, so a row
      // archived without one (an operator archiving a non-completed
      // publication) has to be given a value at archive time.
      const save = asyncMock(undefined);
      entityManager({
        findOne: asyncMock(entity({ completionDate: null })),
        save,
        delete: asyncMock({ affected: 1 }),
      });

      await repository().archiveCompleted('pub-1');

      const archived = save.mock.calls[0]![1] as ArchiveEntityType;
      expect(archived.completionDate).toBeInstanceOf(Date);
    });
  });

  describe('entity → domain mapping', () => {
    it('preserves nullable lifecycle fields as null rather than dropping them', async () => {
      entityManager({
        find: asyncMock([
          entity({
            status: PublicationStatus.FAILED,
            failureReason: 'boom',
            completionAttempts: 3,
          }),
        ]),
      });

      const [publication] = await repository().findFailed();

      expect(publication).toEqual({
        id: 'pub-1',
        listenerId: 'OrderPlacedHandler',
        eventType: 'OrderPlaced',
        serializedEvent: '{"orderId":"o-1"}',
        publicationDate: new Date('2020-01-01T00:00:00.000Z'),
        status: PublicationStatus.FAILED,
        completionDate: null,
        lastResubmissionDate: null,
        completionAttempts: 3,
        failureReason: 'boom',
      });
    });
  });

  describe('dataSource resolution', () => {
    it('resolves the entity manager for its own dataSource, falling back to the injected one', async () => {
      const dataSource = {} as DataSource;
      entityManager({ delete: asyncMock({ affected: 0 }) });

      await new TypeOrmEventPublicationRepository(dataSource, 'billing').delete('pub-1');

      expect(getEntityManagerMock).toHaveBeenCalledWith('billing', dataSource);
    });
  });
});
