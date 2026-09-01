import { PublicationNotFoundError, PublicationStatus } from '@nestjs-transactional/outbox';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { EventPublicationArchiveEntity } from '../../src/entity/event-publication-archive.entity';
import { EventPublicationEntity } from '../../src/entity/event-publication.entity';
import { TypeOrmEventPublicationRepository } from '../../src/repository/typeorm-event-publication.repository';

jest.mock('@nestjs-transactional/typeorm', () => ({
  getCurrentEntityManager: jest.fn(),
}));

const getEntityManagerMock = getCurrentEntityManager as jest.MockedFunction<
  typeof getCurrentEntityManager
>;

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
describe('TypeOrmEventPublicationRepository (unit)', () => {
  /** Chainable stand-in for TypeORM's `UpdateQueryBuilder`. */
  function updateQueryBuilder(result: { affected?: number | null }) {
    return {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(result),
    };
  }

  function entityManager(overrides: Partial<Record<keyof EntityManager, unknown>> = {}) {
    const em = { ...overrides } as unknown as EntityManager;
    getEntityManagerMock.mockReturnValue(em);
    return em;
  }

  function repository(): TypeOrmEventPublicationRepository {
    return new TypeOrmEventPublicationRepository({} as DataSource, 'default');
  }

  function entity(overrides: Partial<EventPublicationEntity> = {}): EventPublicationEntity {
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
      entityManager({ delete: jest.fn().mockResolvedValue({ affected: 7 }) });

      await expect(repository().deleteCompleted()).resolves.toBe(7);
    });

    it('reports zero when the driver omits the affected count', async () => {
      entityManager({ delete: jest.fn().mockResolvedValue({ affected: null }) });

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
      const find = jest.fn().mockResolvedValue([entity()]);
      entityManager({ find });

      const result = await repository().findStale(new Date(), [PublicationStatus.PROCESSING]);

      expect(find).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });
  });

  describe('archiveCompleted', () => {
    it('rejects with PublicationNotFoundError when the row is gone', async () => {
      entityManager({ findOne: jest.fn().mockResolvedValue(null) });

      await expect(repository().archiveCompleted('missing')).rejects.toThrow(
        PublicationNotFoundError,
      );
    });

    it('copies the row into the archive and then removes it from the hot queue', async () => {
      const save = jest.fn().mockResolvedValue(undefined);
      const del = jest.fn().mockResolvedValue({ affected: 1 });
      const completionDate = new Date('2020-02-02T00:00:00.000Z');
      entityManager({
        findOne: jest
          .fn()
          .mockResolvedValue(entity({ status: PublicationStatus.COMPLETED, completionDate })),
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
      const save = jest.fn().mockResolvedValue(undefined);
      entityManager({
        findOne: jest.fn().mockResolvedValue(entity({ completionDate: null })),
        save,
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
      });

      await repository().archiveCompleted('pub-1');

      const archived = save.mock.calls[0]![1] as EventPublicationArchiveEntity;
      expect(archived.completionDate).toBeInstanceOf(Date);
    });
  });

  describe('entity → domain mapping', () => {
    it('preserves nullable lifecycle fields as null rather than dropping them', async () => {
      entityManager({
        find: jest.fn().mockResolvedValue([
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
      entityManager({ delete: jest.fn().mockResolvedValue({ affected: 0 }) });

      await new TypeOrmEventPublicationRepository(dataSource, 'billing').delete('pub-1');

      expect(getEntityManagerMock).toHaveBeenCalledWith('billing', dataSource);
    });
  });
});
