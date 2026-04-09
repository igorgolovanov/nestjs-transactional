import { Externalized } from '@nestjs-transactional/outbox';

import { REFUNDS_BROKER } from './clients';

/**
 * Domain event published from `RefundService.requestRefund`. Three
 * fates are demonstrated by this example, depending on the broker
 * state and the `ClientProxy.emit` outcome:
 *
 *   1. **Happy path**: emit resolves, broker received → publication
 *      COMPLETED. Standard Phase 11 flow.
 *   2. **ADR-016 silent failure**: emit resolves successfully but
 *      broker never received the message (broker stopped, network
 *      partition that the proxy doesn't surface) → publication
 *      ALSO COMPLETED. The framework cannot detect this state.
 *      Mitigation lives on the consumer side (idempotent inbox /
 *      dedup keyed on publication id).
 *   3. **Surfaced failure**: emit throws (proxy refused to enqueue,
 *      explicit broker rejection) → publication FAILED with
 *      `failureReason` recorded. Operator calls
 *      `FailedEventPublications.resubmit()` to retry.
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
