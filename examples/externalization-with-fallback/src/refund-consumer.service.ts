import { Injectable, Logger } from '@nestjs/common';
import { type OutboxEnvelope, OutboxInbox } from '@nestjs/outbox';
import { Transactional } from '@nestjs-transactional/core';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';

import type { RefundRequestedEvent } from './refund-requested.event.js';

/**
 * Consumer-side template. In a real deployment this service lives in
 * another process and receives the envelope from RabbitMQ through an
 * `@EventPattern('refunds')` handler. Here it exposes `process(envelope)`
 * so the integration test can simulate inbound delivery, including the
 * duplicate a redelivery produces.
 *
 * The dedup contract is `@nestjs/outbox`'s inbox: `processInTransaction`
 * records the envelope's `id` for this consumer through the transaction
 * it is given, and runs the work only if the id is new. Because the
 * record and the work commit together, a redelivered message changes
 * nothing, even if the consumer crashed halfway through the first one.
 *
 * The transaction it is given is the one `@Transactional` opened, so
 * the inbox needs no transaction passed in by hand on this side either.
 * In a real consumer the inbox lives in the consumer's own database,
 * next to the effects it guards.
 *
 * Inbox records accumulate. Nothing prunes them for you: run
 * `OutboxInbox.prune('30d')` from a scheduled job, with a window longer
 * than any redelivery.
 */
@Injectable()
export class RefundConsumerService {
  private readonly logger = new Logger(RefundConsumerService.name);

  readonly processed: { refundId: string; messageId: string }[] = [];

  constructor(private readonly inbox: OutboxInbox) {}

  @Transactional()
  async process(
    envelope: OutboxEnvelope<RefundRequestedEvent>,
  ): Promise<'processed' | 'duplicate'> {
    const outcome = await this.inbox.processInTransaction(
      getCurrentEntityManager(),
      'refund-consumer',
      envelope.id,
      () => {
        this.logger.log(
          `Consumer: processing refund ${envelope.payload.refundId} (message ${envelope.id})`,
        );
        // A real consumer issues the refund here, writing through the
        // same transaction so the effect and the inbox record commit
        // together.
        this.processed.push({ refundId: envelope.payload.refundId, messageId: envelope.id });
      },
    );

    if (outcome.duplicate) {
      this.logger.log(`Consumer: skipping duplicate delivery of message ${envelope.id}`);
      return 'duplicate';
    }
    return 'processed';
  }
}
