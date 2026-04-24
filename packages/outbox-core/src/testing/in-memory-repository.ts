/* eslint-disable @typescript-eslint/require-await --
 * This in-memory reference implementation has synchronous method
 * bodies but must return Promises per the EventPublicationRepository
 * SPI contract. Real persistence backends (TypeORM, Prisma, ...) will
 * have awaits throughout.
 */
import { randomUUID } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';
import { IllegalTransactionStateError, TransactionManager } from '@nestjs-transactional/core';

import type {
  EventPublicationRepository,
  FindCompletedOptions,
  FindFailedOptions,
  UpdateStatusOptions,
} from '../repository/event-publication-repository';
import { PublicationNotFoundError } from '../types/errors';
import type { EventPublication, NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';


/**
 * In-memory reference implementation of {@link EventPublicationRepository}.
 *
 * Intended for unit and integration tests of outbox-core consumers that
 * do not want to spin up a real database. Not thread-safe — do not use
 * in production.
 *
 * Optional `TransactionManager` enables transaction-aware behaviour:
 * when a mutating method is called inside an active transaction, the
 * repository registers an `afterRollback` hook that undoes the change
 * — so the visible state after rollback matches what a real
 * transactional backend would show. When no `TransactionManager` is
 * provided (or no transaction is active), mutations apply immediately
 * and are not undone.
 *
 * Exposes a few extra methods beyond the SPI (`reset`, `getAll`,
 * `count`) to help tests set up and assert on state.
 */
@Injectable()
export class InMemoryEventPublicationRepository implements EventPublicationRepository {
  private readonly publications = new Map<string, EventPublication>();

  constructor(
    @Optional()
    private readonly transactionManager?: TransactionManager,
  ) {}

  async createAll(inputs: NewEventPublication[]): Promise<EventPublication[]> {
    const created: EventPublication[] = [];
    for (const input of inputs) {
      const publication: EventPublication = {
        id: randomUUID(),
        listenerId: input.listenerId,
        eventType: input.eventType,
        serializedEvent: input.serializedEvent,
        publicationDate: input.publicationDate ?? new Date(),
        status: PublicationStatus.PUBLISHED,
        completionDate: null,
        lastResubmissionDate: null,
        completionAttempts: 0,
        failureReason: null,
      };
      this.publications.set(publication.id, publication);
      created.push(publication);
    }

    this.trackRollback(() => {
      for (const p of created) {
        this.publications.delete(p.id);
      }
    });

    return created;
  }

  async findById(id: string): Promise<EventPublication | null> {
    return this.publications.get(id) ?? null;
  }

  async updateStatus(
    id: string,
    status: PublicationStatus,
    options: UpdateStatusOptions = {},
  ): Promise<void> {
    const existing = this.publications.get(id);
    if (!existing) {
      throw new PublicationNotFoundError(id);
    }

    const updated: EventPublication = {
      ...existing,
      status,
      completionDate: options.completionDate ?? existing.completionDate,
      failureReason: options.failureReason ?? existing.failureReason,
      completionAttempts: options.incrementAttempts
        ? existing.completionAttempts + 1
        : existing.completionAttempts,
      lastResubmissionDate: options.lastResubmissionDate ?? existing.lastResubmissionDate,
    };
    this.publications.set(id, updated);

    this.trackRollback(() => {
      this.publications.set(id, existing);
    });
  }

  async tryClaim(id: string): Promise<boolean> {
    const existing = this.publications.get(id);
    if (!existing) {
      return false;
    }
    if (
      existing.status !== PublicationStatus.PUBLISHED &&
      existing.status !== PublicationStatus.RESUBMITTED
    ) {
      return false;
    }

    await this.updateStatus(id, PublicationStatus.PROCESSING, { incrementAttempts: true });
    return true;
  }

  async findReadyForProcessing(limit: number): Promise<EventPublication[]> {
    return Array.from(this.publications.values())
      .filter(
        (p) =>
          p.status === PublicationStatus.PUBLISHED ||
          p.status === PublicationStatus.RESUBMITTED,
      )
      .slice(0, limit);
  }

  async findStale(
    beforeDate: Date,
    statuses: PublicationStatus[],
  ): Promise<EventPublication[]> {
    return Array.from(this.publications.values()).filter(
      (p) => statuses.includes(p.status) && p.publicationDate < beforeDate,
    );
  }

  async findCompleted(options?: FindCompletedOptions): Promise<EventPublication[]> {
    let result = Array.from(this.publications.values()).filter(
      (p) => p.status === PublicationStatus.COMPLETED,
    );

    const olderThan = options?.olderThan;
    if (olderThan) {
      result = result.filter((p) => p.completionDate !== null && p.completionDate < olderThan);
    }

    const limit = options?.limit;
    if (limit !== undefined) {
      result = result.slice(0, limit);
    }

    return result;
  }

  async findIncomplete(): Promise<EventPublication[]> {
    return Array.from(this.publications.values()).filter(
      (p) => p.status !== PublicationStatus.COMPLETED,
    );
  }

  async findFailed(options?: FindFailedOptions): Promise<EventPublication[]> {
    let result = Array.from(this.publications.values()).filter(
      (p) => p.status === PublicationStatus.FAILED,
    );

    const minAge = options?.minAge;
    if (minAge) {
      const threshold = new Date(Date.now() - minAge);
      result = result.filter((p) => p.publicationDate < threshold);
    }

    const maxAttempts = options?.maxAttempts;
    if (maxAttempts !== undefined) {
      result = result.filter((p) => p.completionAttempts <= maxAttempts);
    }

    return result;
  }

  async deleteCompleted(olderThan?: Date): Promise<number> {
    const deleted: [string, EventPublication][] = [];
    for (const [id, p] of this.publications.entries()) {
      if (p.status !== PublicationStatus.COMPLETED) {
        continue;
      }
      if (olderThan && (p.completionDate === null || p.completionDate >= olderThan)) {
        continue;
      }
      deleted.push([id, p]);
    }
    for (const [id] of deleted) {
      this.publications.delete(id);
    }

    if (deleted.length > 0) {
      this.trackRollback(() => {
        for (const [id, p] of deleted) {
          this.publications.set(id, p);
        }
      });
    }

    return deleted.length;
  }

  async archiveCompleted(id: string): Promise<void> {
    const existing = this.publications.get(id);
    this.publications.delete(id);

    if (existing !== undefined) {
      this.trackRollback(() => {
        this.publications.set(id, existing);
      });
    }
  }

  async delete(id: string): Promise<void> {
    const existing = this.publications.get(id);
    this.publications.delete(id);

    if (existing !== undefined) {
      this.trackRollback(() => {
        this.publications.set(id, existing);
      });
    }
  }

  // --- Testing helpers (not part of the SPI) ---

  /** Drop every stored publication. Does not interact with transactions. */
  reset(): void {
    this.publications.clear();
  }

  /** Snapshot of every stored publication, in insertion order. */
  getAll(): EventPublication[] {
    return Array.from(this.publications.values());
  }

  /** Number of stored publications. */
  count(): number {
    return this.publications.size;
  }

  /**
   * If a `TransactionManager` was provided and a transaction is active,
   * register the given `undo` closure to fire on rollback. Otherwise
   * this is a no-op.
   */
  private trackRollback(undo: () => void): void {
    if (this.transactionManager === undefined) {
      return;
    }
    try {
      this.transactionManager.registerAfterRollback(async () => {
        undo();
      });
    } catch (err) {
      if (err instanceof IllegalTransactionStateError) {
        return;
      }
      throw err;
    }
  }
}
