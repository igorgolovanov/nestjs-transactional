import { Externalized } from '@nestjs-transactional/outbox';

import { REFUNDS_BROKER } from './clients';

/**
 * Domain event published from `RefundService.requestRefund`. Two
 * fates are demonstrated by this example:
 *
 *   1. **Happy path**: emit resolves and the publication is
 *      COMPLETED. On this RabbitMQ that means a publisher confirm
 *      arrived, so the message really is on the queue. What a
 *      completion proves varies by transport (ADR-021).
 *   2. **Surfaced failure**: emit rejects, because the broker is
 *      down or refused the message, and the publication is FAILED
 *      with a readable `failureReason`. An operator calls
 *      `FailedEventPublications.resubmit()` to retry.
 *
 * The consumer-side inbox in this example is not a workaround for
 * either of those. Delivery is at-least-once by design, so
 * duplicates are expected and deduplicating on the receiving side
 * is what turns that into exactly-once effects.
 */
@Externalized<RefundRequestedEvent>({
  target: 'refunds',
  client: REFUNDS_BROKER,
  headers: (event) => ({
    'x-event-type': 'RefundRequestedEvent',
    'x-correlation-id': event.refundId,
  }),
})
export class RefundRequestedEvent {
  constructor(
    public readonly refundId: string,
    public readonly orderId: string,
    public readonly amountCents: number,
  ) {}
}
