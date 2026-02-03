import { Inject, Injectable } from '@nestjs/common';

import {
  EVENT_PUBLICATION_REPOSITORY,
} from '../repository/event-publication-repository';
import type { EventPublicationRepository } from '../repository/event-publication-repository';
import { EVENT_SERIALIZER } from '../serialization/event-serializer';
import type { EventSerializer } from '../serialization/event-serializer';
import { CompletionMode } from '../types/completion-mode';
import type { EventPublication, NewEventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';


/**
 * Central service that coordinates the event publication lifecycle.
 *
 * Responsibilities:
 * - persist publication entries (one per listener) atomically with the
 *   business transaction via the injected {@link EventPublicationRepository};
 * - transition lifecycle states (`PUBLISHED` → `PROCESSING` →
 *   `COMPLETED` / `FAILED` → `RESUBMITTED`);
 * - hand out deserialized event payloads ready for listener invocation.
 *
 * Does NOT invoke listeners — that is the dispatcher's job (Phase 5.6).
 * Inspired by the internals of Spring Modulith's Event Publication
 * Registry.
 */
@Injectable()
export class EventPublicationRegistry {
  constructor(
    @Inject(EVENT_PUBLICATION_REPOSITORY)
    private readonly repository: EventPublicationRepository,
    @Inject(EVENT_SERIALIZER)
    private readonly serializer: EventSerializer,
  ) {}

  /**
   * Persist one publication entry per listener for a single event.
   *
   * Must be called inside an active transaction so the entries are
   * committed atomically with the business write. Returns an empty
   * array when there are no listeners — no repository call is made.
   *
   * The event's `constructor.name` is stored as `eventType` and used
   * by the deserializer to look up the class at delivery time.
   */
  async publish(event: unknown, listenerIds: readonly string[]): Promise<EventPublication[]> {
    if (listenerIds.length === 0) {
      return [];
    }

    // Delegate validation of the event shape (must be an object) to the
    // serializer — it throws SerializationError with a clear message.
    const serialized = this.serializer.serialize(event);
    const eventType = (event as object).constructor.name;

    const inputs: NewEventPublication[] = listenerIds.map((listenerId) => ({
      listenerId,
      eventType,
      serializedEvent: serialized,
    }));

    return this.repository.createAll(inputs);
  }

  /**
   * Atomically transition the publication from `PUBLISHED` or
   * `RESUBMITTED` to `PROCESSING`. Returns `true` when the claim
   * succeeded, `false` when another worker already holds it or the
   * publication is in a terminal state.
   */
  async tryClaim(publicationId: string): Promise<boolean> {
    return this.repository.tryClaim(publicationId);
  }

  /**
   * Mark the publication as completed using the requested
   * {@link CompletionMode}:
   * - `UPDATE` (default): set `completion_date` and keep the row for audit;
   * - `DELETE`: delete the row outright;
   * - `ARCHIVE`: move the row to the archive table (impl-specific).
   */
  async markCompleted(
    publicationId: string,
    mode: CompletionMode = CompletionMode.UPDATE,
  ): Promise<void> {
    switch (mode) {
      case CompletionMode.UPDATE:
        await this.repository.updateStatus(publicationId, PublicationStatus.COMPLETED, {
          completionDate: new Date(),
        });
        return;
      case CompletionMode.DELETE:
        await this.repository.delete(publicationId);
        return;
      case CompletionMode.ARCHIVE:
        await this.repository.archiveCompleted(publicationId);
        return;
    }
  }

  /**
   * Mark the publication as failed, storing the given reason so
   * operators can triage.
   */
  async markFailed(publicationId: string, reason: string): Promise<void> {
    await this.repository.updateStatus(publicationId, PublicationStatus.FAILED, {
      failureReason: reason,
    });
  }

  /**
   * Mark a previously-failed publication as resubmitted for retry.
   * Stamps `lastResubmissionDate` with the current time.
   */
  async markResubmitted(publicationId: string): Promise<void> {
    await this.repository.updateStatus(publicationId, PublicationStatus.RESUBMITTED, {
      lastResubmissionDate: new Date(),
    });
  }

  /**
   * Decode the stored payload back into an application object via the
   * configured {@link EventSerializer}. Delivered to the listener as-is.
   */
  deserialize(publication: EventPublication): unknown {
    return this.serializer.deserialize(publication.serializedEvent, publication.eventType);
  }

  /**
   * Pass-through to {@link EventPublicationRepository.findReadyForProcessing}
   * — used by the (upcoming) async dispatcher to pull work.
   */
  async findReadyForProcessing(limit: number): Promise<EventPublication[]> {
    return this.repository.findReadyForProcessing(limit);
  }
}
