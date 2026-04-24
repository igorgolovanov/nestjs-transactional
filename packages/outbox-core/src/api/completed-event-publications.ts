import { Inject, Injectable } from '@nestjs/common';

import {
  EVENT_PUBLICATION_REPOSITORY,
  type EventPublicationRepository,
} from '../repository/event-publication-repository';
import type { EventPublication } from '../types/event-publication';

/**
 * Operator-facing query + purge API for publications that have
 * reached the terminal `COMPLETED` state. Equivalent to Spring
 * Modulith's `CompletedEventPublications`.
 *
 * Relevant when the completion mode is `UPDATE` (the default) — the
 * row is kept for audit and needs to be purged eventually.
 */
@Injectable()
export class CompletedEventPublications {
  constructor(
    @Inject(EVENT_PUBLICATION_REPOSITORY)
    private readonly repository: EventPublicationRepository,
  ) {}

  /**
   * Return completed publications, optionally filtered by
   * `completionDate` and capped by `limit`.
   */
  async findAll(options?: {
    readonly olderThan?: Date;
    readonly limit?: number;
  }): Promise<EventPublication[]> {
    return this.repository.findCompleted(options);
  }

  /** How many publications are currently in `COMPLETED`. */
  async count(): Promise<number> {
    const completed = await this.repository.findCompleted();
    return completed.length;
  }

  /**
   * Delete completed publications. When `olderThan` is provided, only
   * publications whose `completionDate` is strictly before it are
   * removed. Returns the number of rows deleted.
   */
  async purge(olderThan?: Date): Promise<number> {
    return this.repository.deleteCompleted(olderThan);
  }
}
