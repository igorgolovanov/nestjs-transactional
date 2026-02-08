import { Inject, Injectable } from '@nestjs/common';

import {
  EVENT_PUBLICATION_REPOSITORY,
  type EventPublicationRepository,
} from '../repository/event-publication-repository';
import type { EventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';
import { ResubmissionOptions } from '../types/resubmission-options';


/**
 * Operator-facing query + resubmit API for publications currently in
 * the `FAILED` state. Equivalent to Spring Modulith's
 * `FailedEventPublications`.
 */
@Injectable()
export class FailedEventPublications {
  constructor(
    @Inject(EVENT_PUBLICATION_REPOSITORY)
    private readonly repository: EventPublicationRepository,
  ) {}

  /**
   * Return every failed publication matching the optional filters
   * (minimum age in ms since `publicationDate`, cap on
   * `completionAttempts`).
   */
  async findAll(options?: {
    readonly minAge?: number;
    readonly maxAttempts?: number;
  }): Promise<EventPublication[]> {
    return this.repository.findFailed(options);
  }

  /** How many publications are currently in `FAILED`. */
  async count(): Promise<number> {
    const failed = await this.repository.findFailed();
    return failed.length;
  }

  /**
   * Transition selected failed publications to `RESUBMITTED` so the
   * processor will pick them up again. Returns the number of rows
   * transitioned.
   *
   * Selection order:
   * 1. Pull failed publications matching the `minAge` /
   *    `maxCompletionAttempts` filters.
   * 2. Apply the user-supplied `filter` predicate, if any.
   * 3. Keep at most `batchSize` publications.
   */
  async resubmit(
    options: ResubmissionOptions = ResubmissionOptions.defaults(),
  ): Promise<number> {
    const failed = await this.repository.findFailed({
      minAge: options.minAge,
      maxAttempts: options.maxCompletionAttempts ?? undefined,
    });

    const filtered = options.filter !== null ? failed.filter(options.filter) : failed;
    const toProcess = filtered.slice(0, options.batchSize);

    for (const pub of toProcess) {
      await this.repository.updateStatus(pub.id, PublicationStatus.RESUBMITTED, {
        lastResubmissionDate: new Date(),
      });
    }

    return toProcess.length;
  }
}
