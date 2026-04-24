/* eslint-disable @typescript-eslint/require-await --
 * This in-memory reference implementation has synchronous method
 * bodies but must return Promises per the EventPublicationRepository
 * SPI contract. Real persistence backends (TypeORM, Prisma, ...) will
 * have awaits throughout.
 */
import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

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
 * do not want to spin up a real database. Not thread-safe and not
 * transactional — do not use in production.
 *
 * Exposes a few extra methods beyond the SPI (`reset`, `getAll`,
 * `count`) to help tests set up and assert on state.
 */
@Injectable()
export class InMemoryEventPublicationRepository implements EventPublicationRepository {
  private readonly publications = new Map<string, EventPublication>();

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
    const toDelete: string[] = [];
    for (const [id, p] of this.publications.entries()) {
      if (p.status !== PublicationStatus.COMPLETED) {
        continue;
      }
      if (olderThan && (p.completionDate === null || p.completionDate >= olderThan)) {
        continue;
      }
      toDelete.push(id);
    }
    for (const id of toDelete) {
      this.publications.delete(id);
    }
    return toDelete.length;
  }

  async archiveCompleted(id: string): Promise<void> {
    // In-memory has no separate archive table — archival is a plain delete.
    this.publications.delete(id);
  }

  async delete(id: string): Promise<void> {
    this.publications.delete(id);
  }

  // --- Testing helpers (not part of the SPI) ---

  /** Drop every stored publication. */
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
}
