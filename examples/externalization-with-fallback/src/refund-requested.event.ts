import { Externalized } from '@nestjs-transactional/outbox';

import { REFUNDS_BROKER } from './clients.js';

/**
 * Domain event published from `RefundService.requestRefund` and
 * delivered to RabbitMQ. Two fates are demonstrated by this example:
 *
 *   1. **Happy path**: the emit resolves, and the message leaves the
 *      outbox. On this RabbitMQ that means a publisher confirm arrived,
 *      so the message really is on the queue. What a delivery proves
 *      varies by transport (ADR-021).
 *   2. **Broker failure**: the emit rejects, because the broker is down
 *      or refused the message. The message stays in the outbox with the
 *      reason and is retried with backoff; once the attempts run out it
 *      is dead-lettered, and an operator requeues it.
 *
 * The consumer-side inbox in this example is not a workaround for
 * either of those. Delivery is at-least-once by design, so duplicates
 * are expected, and deduplicating on the receiving side is what turns
 * that into exactly-once effects.
 */
@Externalized<RefundRequestedEvent>({
  target: 'refunds',
  client: REFUNDS_BROKER,
  headers: (event) => ({ 'x-correlation-id': event.refundId }),
})
export class RefundRequestedEvent {
  constructor(
    public readonly refundId: string,
    public readonly orderId: string,
    public readonly amountCents: number,
  ) {}
}
