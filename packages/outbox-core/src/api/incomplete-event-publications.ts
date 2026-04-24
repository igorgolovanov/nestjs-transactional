import { Inject, Injectable } from '@nestjs/common';

import {
  EVENT_PUBLICATION_REPOSITORY,
  type EventPublicationRepository,
} from '../repository/event-publication-repository';
import type { EventPublication } from '../types/event-publication';
import { PublicationStatus } from '../types/publication-status';
import { ResubmissionOptions } from '../types/resubmission-options';


/**
 * Operator-facing query + resubmit API for every publication that has
 * not yet reached the terminal `COMPLETED` state. Equivalent to Spring
 * Modulith's `IncompleteEventPublications`.
 *
 * Typical use case: startup / restart recovery — query the backlog,
 * bulk-resubmit retriable rows, let the processor drain.
 */
@Injectable()
export class IncompleteEventPublications {
  constructor(
    @Inject(EVENT_PUBLICATION_REPOSITORY)
    private readonly repository: EventPublicationRepository,
  ) {}

  /** Return every publication whose status is not `COMPLETED`. */
  async findAll(): Promise<EventPublication[]> {
    return this.repository.findIncomplete();
  }

  /** How many publications are currently not `COMPLETED`. */
  async count(): Promise<number> {
    const incomplete = await this.repository.findIncomplete();
    return incomplete.length;
  }

  /**
   * Scan every non-completed publication and transition retriable
   * ones (`FAILED`, `PUBLISHED`) to `RESUBMITTED`. Publications
   * currently `PROCESSING` or `RESUBMITTED` are left untouched —
   * `PROCESSING` is owned by a worker and `RESUBMITTED` is already in
   * the retry queue. Returns the number of rows transitioned.
   */
  async resubmitIncompletePublications(
    options: ResubmissionOptions = ResubmissionOptions.defaults(),
  ): Promise<number> {
    const incomplete = await this.repository.findIncomplete();

    const filtered = options.filter !== null ? incomplete.filter(options.filter) : incomplete;
    const toProcess = filtered.slice(0, options.batchSize);

    let resubmitted = 0;
    for (const pub of toProcess) {
      if (
        pub.status === PublicationStatus.FAILED ||
        pub.status === PublicationStatus.PUBLISHED
      ) {
        await this.repository.updateStatus(pub.id, PublicationStatus.RESUBMITTED, {
          lastResubmissionDate: new Date(),
        });
        resubmitted++;
      }
    }

    return resubmitted;
  }
}
