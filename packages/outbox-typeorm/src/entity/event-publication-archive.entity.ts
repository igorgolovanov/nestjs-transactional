import { PublicationStatus } from '@nestjs-transactional/outbox-core';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Archive table for event publications that have been completed and
 * moved out of the hot queue — used by the `ARCHIVE` completion mode.
 * Rows never change after insertion; this table is intended for audit,
 * debugging, and compliance review rather than worker-time queries.
 *
 * Schema mirrors {@link EventPublicationEntity} except that
 * `completionDate` is non-nullable — a publication is only archived
 * after it has completed, so the field is always populated.
 */
@Entity('event_publication_archive')
@Index(['completionDate'])
@Index(['listenerId'])
@Index(['eventType'])
export class EventPublicationArchiveEntity {
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

  @Column({ type: 'varchar', length: 32 })
  status!: PublicationStatus;

  @Column({ name: 'completion_date', type: 'timestamptz' })
  completionDate!: Date;

  @Column({ name: 'last_resubmission_date', type: 'timestamptz', nullable: true })
  lastResubmissionDate!: Date | null;

  @Column({ name: 'completion_attempts', type: 'int' })
  completionAttempts!: number;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason!: string | null;
}
