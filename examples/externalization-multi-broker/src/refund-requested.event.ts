import { Externalized } from '@nestjs-transactional/outbox';

import { RABBITMQ_CLIENT } from './clients';

/**
 * Domain event routed to **RabbitMQ** — work-queue semantics with
 * per-message acknowledgments. Suits command-style integration where
 * each event corresponds to a unit of work that some service needs to
 * process exactly once (idempotently) and ack.
 *
 * `target` is a queue name in the canonical `@nestjs/microservices`
 * RMQ transport; consumers subscribe to it via
 * `MicroserviceOptions { transport: Transport.RMQ, options: { queue:
 * 'refunds' } }`.
 */
@Externalized<RefundRequestedEvent>({
  target: 'refunds',
  client: RABBITMQ_CLIENT,
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
