import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { ProcessedRefundEntity } from './processed-refunds.entity';
import { RefundRequestedEvent } from './refund-requested.event';

/**
 * Consumer-side template (ADR-016 mitigation strategy 2). In a real
 * deployment this service would live in a different process and
 * receive `RefundRequestedEvent` from RabbitMQ via a
 * `@MessagePattern('refunds')` handler. Here it just exposes a
 * `process(event, publicationId)` method so the integration test can
 * simulate inbound delivery.
 *
 * The dedup contract:
 *
 *   1. SELECT from `processed_refunds` WHERE publicationId = ?.
 *   2. If a row exists → noop (already processed this delivery).
 *   3. Otherwise: do the actual work (in this example: log) AND
 *      INSERT a row into `processed_refunds`. Same transaction.
 *
 * The check + insert run in one `@Transactional()` so concurrent
 * deliveries of the same publication id can't both pass the SELECT
 * (Postgres' default REPEATABLE READ for the row would let a second
 * tx overwrite if not for the PRIMARY KEY constraint causing the
 * second INSERT to throw — that's the racy correctness gate; the
 * SELECT-first is the optimisation that avoids paying the work
 * twice in the common case).
 *
 * Real implementations also handle:
 *   - Cleanup / TTL of the dedup table (this example just grows).
 *   - Cross-restart durability (this example uses Postgres which
 *     gives that for free).
 *   - Out-of-order delivery (Kafka per-key ordering, RabbitMQ FIFO
 *     queue — broker-dependent).
 */
@Injectable()
export class RefundConsumerService {
  private readonly logger = new Logger(RefundConsumerService.name);

  readonly processed: { event: RefundRequestedEvent; publicationId: string }[] = [];

  constructor(
    @InjectRepository(ProcessedRefundEntity)
    private readonly inbox: Repository<ProcessedRefundEntity>,
  ) {}

  @Transactional()
  async process(event: RefundRequestedEvent, publicationId: string): Promise<'processed' | 'duplicate'> {
    const existing = await this.inbox.findOne({ where: { publicationId } });
    if (existing !== null) {
      this.logger.log(
        `Consumer: skipping duplicate delivery for publication ${publicationId} (refund ${event.refundId})`,
      );
      return 'duplicate';
    }

    this.logger.log(`Consumer: processing refund ${event.refundId} (publication ${publicationId})`);

    // Real consumer would issue the actual refund here (call payment
    // gateway, etc.). The example just tracks what was processed.
    this.processed.push({ event, publicationId });

    await this.inbox.save({
      publicationId,
      refundId: event.refundId,
      processedAt: new Date(),
    });

    return 'processed';
  }
}
