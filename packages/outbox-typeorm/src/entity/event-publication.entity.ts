import { PublicationStatus } from '@nestjs-transactional/outbox';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Hot-queue TypeORM entity backing the Event Publication Registry.
 *
 * Schema follows the contract of `EventPublication` from
 * `@nestjs-transactional/outbox`. Rows move through the lifecycle
 * `PUBLISHED → PROCESSING → COMPLETED` (or `FAILED → RESUBMITTED → ...`
 * on retry).
 *
 * Indexes:
 * - `(status, publicationDate)` — primary index for `findReadyForProcessing`
 *   (worker poll) and `findStale` (staleness monitor).
 * - `(status, listenerId)` — looking up retries scoped to a single listener.
 * - `(eventType)` — operator queries and event externalization filters.
 * - `(completionDate)` — `findCompleted(olderThan)` and
 *   `deleteCompleted(olderThan)` cleanup.
 *
 * `status` is stored as `varchar(32)` rather than a Postgres `enum` type
 * to avoid schema churn whenever a new lifecycle state is introduced.
 */
@Entity('event_publication')
@Index(['status', 'publicationDate'])
@Index(['status', 'listenerId'])
@Index(['eventType'])
@Index(['completionDate'])
export class EventPublicationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'listener_id', length: 512 })
  listenerId!: string;

  @Column({ name: 'event_type', length: 256 })
  eventType!: string;

  @Column({ name: 'serialized_event', type: 'text' })
  serializedEvent!: string;

  @Column({ name: 'publication_date', type: 'timestamptz' })
  publicationDate!: Date;

  @Column({
    type: 'varchar',
    length: 32,
    default: PublicationStatus.PUBLISHED,
  })
  status!: PublicationStatus;

  @Column({ name: 'completion_date', type: 'timestamptz', nullable: true })
  completionDate!: Date | null;

  @Column({ name: 'last_resubmission_date', type: 'timestamptz', nullable: true })
  lastResubmissionDate!: Date | null;

  @Column({ name: 'completion_attempts', type: 'int', default: 0 })
  completionAttempts!: number;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason!: string | null;
}
