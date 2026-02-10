import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  PublicationNotFoundError,
  PublicationStatus,
  type EventPublication,
  type EventPublicationRepository,
  type FindCompletedOptions,
  type FindFailedOptions,
  type NewEventPublication,
  type UpdateStatusOptions,
} from '@nestjs-transactional/outbox-core';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import {
  In,
  LessThan,
  LessThanOrEqual,
  Not,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
} from 'typeorm';

import { EventPublicationArchiveEntity } from '../entity/event-publication-archive.entity';
import { EventPublicationEntity } from '../entity/event-publication.entity';

/**
 * TypeORM-backed implementation of
 * {@link EventPublicationRepository}. Reads and writes go through the
 * {@link EntityManager} bound to the ambient transaction (via
 * `@nestjs-transactional/core`'s `AsyncLocalStorage`), so publication
 * rows commit atomically with the business data.
 *
 * `findReadyForProcessing` uses `SELECT ... FOR UPDATE SKIP LOCKED` so
 * multiple workers can poll the queue concurrently without fighting
 * over the same rows. `tryClaim` uses a conditional `UPDATE` that
 * transitions `PUBLISHED`/`RESUBMITTED` → `PROCESSING` atomically and
 * returns whether the row was actually claimed, so a losing worker can
 * move on to the next publication.
 *
 * The repository is adapter-instance-aware: pass a non-default
 * `adapterInstance` when the application uses multiple DataSources
 * (`'primary'`, `'billing'`, ...). The fallback {@link DataSource}
 * passed to the constructor is used when `getCurrentEntityManager` is
 * called outside any active transaction — typical for operator-facing
 * read APIs.
 */
@Injectable()
export class TypeOrmEventPublicationRepository implements EventPublicationRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly adapterInstance = 'default',
  ) {}

  private get em(): EntityManager {
    return getCurrentEntityManager(this.adapterInstance, this.dataSource);
  }

  async createAll(inputs: NewEventPublication[]): Promise<EventPublication[]> {
    const entities = inputs.map((input) => {
      const entity = new EventPublicationEntity();
      entity.id = randomUUID();
      entity.listenerId = input.listenerId;
      entity.eventType = input.eventType;
      entity.serializedEvent = input.serializedEvent;
      entity.publicationDate = input.publicationDate ?? new Date();
      entity.status = PublicationStatus.PUBLISHED;
      entity.completionDate = null;
      entity.lastResubmissionDate = null;
      entity.completionAttempts = 0;
      entity.failureReason = null;
      return entity;
    });

    await this.em.save(EventPublicationEntity, entities);
    return entities.map(toDomain);
  }

  async findById(id: string): Promise<EventPublication | null> {
    const entity = await this.em.findOne(EventPublicationEntity, { where: { id } });
    return entity ? toDomain(entity) : null;
  }

  async updateStatus(
    id: string,
    status: PublicationStatus,
    options: UpdateStatusOptions = {},
  ): Promise<void> {
    // Build the SET clause inline: TypeORM's `.set()` accepts raw SQL
    // fragments as `() => string`, so we can bump `completionAttempts`
    // atomically without a separate `em.increment()` call.
    await this.em
      .createQueryBuilder()
      .update(EventPublicationEntity)
      .set({
        status,
        ...(options.completionDate !== undefined
          ? { completionDate: options.completionDate }
          : {}),
        ...(options.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
        ...(options.lastResubmissionDate !== undefined
          ? { lastResubmissionDate: options.lastResubmissionDate }
          : {}),
        ...(options.incrementAttempts
          ? { completionAttempts: () => 'completion_attempts + 1' }
          : {}),
      })
      .where('id = :id', { id })
      .execute();
  }

  async tryClaim(id: string): Promise<boolean> {
    // Atomic conditional update: only transitions the row when the
    // current status is one the worker is allowed to claim. `affected`
    // tells us whether we won the race — losers get 0 and back off.
    const result = await this.em
      .createQueryBuilder()
      .update(EventPublicationEntity)
      .set({
        status: PublicationStatus.PROCESSING,
        completionAttempts: () => 'completion_attempts + 1',
      })
      .where('id = :id AND status IN (:...statuses)', {
        id,
        statuses: [PublicationStatus.PUBLISHED, PublicationStatus.RESUBMITTED],
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async findReadyForProcessing(limit: number): Promise<EventPublication[]> {
    const entities = await this.em
      .createQueryBuilder(EventPublicationEntity, 'p')
      .where('p.status IN (:...statuses)', {
        statuses: [PublicationStatus.PUBLISHED, PublicationStatus.RESUBMITTED],
      })
      .orderBy('p.publication_date', 'ASC')
      .limit(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();

    return entities.map(toDomain);
  }

  async findStale(
    beforeDate: Date,
    statuses: PublicationStatus[],
  ): Promise<EventPublication[]> {
    if (statuses.length === 0) {
      return [];
    }
    const entities = await this.em.find(EventPublicationEntity, {
      where: {
        status: In(statuses),
        publicationDate: LessThan(beforeDate),
      },
    });
    return entities.map(toDomain);
  }

  async findCompleted(options?: FindCompletedOptions): Promise<EventPublication[]> {
    const where: FindOptionsWhere<EventPublicationEntity> = {
      status: PublicationStatus.COMPLETED,
    };
    if (options?.olderThan !== undefined) {
      where.completionDate = LessThan(options.olderThan);
    }

    const entities = await this.em.find(EventPublicationEntity, {
      where,
      ...(options?.limit !== undefined ? { take: options.limit } : {}),
      order: { completionDate: 'DESC' },
    });
    return entities.map(toDomain);
  }

  async findIncomplete(): Promise<EventPublication[]> {
    const entities = await this.em.find(EventPublicationEntity, {
      where: { status: Not(PublicationStatus.COMPLETED) },
    });
    return entities.map(toDomain);
  }

  async findFailed(options?: FindFailedOptions): Promise<EventPublication[]> {
    const where: FindOptionsWhere<EventPublicationEntity> = {
      status: PublicationStatus.FAILED,
    };
    if (options?.minAge !== undefined) {
      where.publicationDate = LessThan(new Date(Date.now() - options.minAge));
    }
    if (options?.maxAttempts !== undefined) {
      where.completionAttempts = LessThanOrEqual(options.maxAttempts);
    }

    const entities = await this.em.find(EventPublicationEntity, { where });
    return entities.map(toDomain);
  }

  async deleteCompleted(olderThan?: Date): Promise<number> {
    const where: FindOptionsWhere<EventPublicationEntity> = {
      status: PublicationStatus.COMPLETED,
    };
    if (olderThan !== undefined) {
      where.completionDate = LessThan(olderThan);
    }
    const result = await this.em.delete(EventPublicationEntity, where);
    return result.affected ?? 0;
  }

  async archiveCompleted(id: string): Promise<void> {
    // Deliberately does not open a nested TypeORM transaction — the
    // ambient `@Transactional` scope (the processor always wraps the
    // listener invocation in one) gives us atomicity between the
    // archive insert and the hot-queue delete. If called outside a
    // transaction, TypeORM executes both statements autocommit; the
    // window of inconsistency is the round-trip between the two
    // statements, which is acceptable for an archive operation.
    const entity = await this.em.findOne(EventPublicationEntity, { where: { id } });
    if (entity === null) {
      throw new PublicationNotFoundError(id);
    }

    const archive = new EventPublicationArchiveEntity();
    archive.id = entity.id;
    archive.listenerId = entity.listenerId;
    archive.eventType = entity.eventType;
    archive.serializedEvent = entity.serializedEvent;
    archive.publicationDate = entity.publicationDate;
    archive.status = entity.status;
    archive.completionDate = entity.completionDate ?? new Date();
    archive.lastResubmissionDate = entity.lastResubmissionDate;
    archive.completionAttempts = entity.completionAttempts;
    archive.failureReason = entity.failureReason;

    await this.em.save(EventPublicationArchiveEntity, archive);
    await this.em.delete(EventPublicationEntity, { id });
  }

  async delete(id: string): Promise<void> {
    await this.em.delete(EventPublicationEntity, { id });
  }
}

function toDomain(entity: EventPublicationEntity): EventPublication {
  return {
    id: entity.id,
    listenerId: entity.listenerId,
    eventType: entity.eventType,
    serializedEvent: entity.serializedEvent,
    publicationDate: entity.publicationDate,
    status: entity.status,
    completionDate: entity.completionDate,
    lastResubmissionDate: entity.lastResubmissionDate,
    completionAttempts: entity.completionAttempts,
    failureReason: entity.failureReason,
  };
}
