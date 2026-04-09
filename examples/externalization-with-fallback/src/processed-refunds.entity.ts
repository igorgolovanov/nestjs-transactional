import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Inbox / dedup table for the consumer-side mitigation pattern from
 * ADR-016. Each row records that a publication id has been
 * processed; `RefundConsumerService.process` checks this table
 * BEFORE doing the actual refund work, so a duplicate delivery
 * (broker redelivers, processor resubmits, network retry, ...) is
 * a no-op.
 *
 * In Spring Modulith terms this is the "inbox pattern" complementary
 * to the publisher's outbox: the producer guarantees at-least-once
 * via the outbox; the consumer guarantees at-most-once execution
 * via this dedup table. Together: exactly-once *effects*, even
 * though message delivery is at-least-once.
 *
 * Production implementations make this table cleanup-aware (TTL,
 * archive after N days). The example just keeps the rows.
 */
@Entity({ name: 'processed_refunds' })
export class ProcessedRefundEntity {
  /**
   * Outbox publication id. Stable across retries — the same row
   * stays in `event_publication` whether the externalizer succeeded
   * or failed and was resubmitted.
   */
  @PrimaryColumn({ type: 'text' })
  publicationId!: string;

  @Column({ type: 'text' })
  refundId!: string;

  @Column({ type: 'timestamptz' })
  processedAt!: Date;
}
