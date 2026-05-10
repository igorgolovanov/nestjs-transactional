import { Injectable } from '@nestjs/common';
import {
  type IOutboxEventHandler,
  OutboxEventsHandler,
} from '@nestjs-transactional/outbox';

import { OrderConfirmedEvent } from '../shared/events';

/**
 * Stub local listener for `OrderConfirmedEvent`. Registered solely
 * to satisfy `OutboxEventPublisher.publish`'s "at least one
 * listener" gate (Convention #15) — without it, the publish call
 * is a silent no-op and the publication row never reaches the
 * worker's externalization pipeline. With this stub registered,
 * one publication row is created on the orders DS; the worker
 * picks it up, sees the event class carries `@Externalized`
 * metadata, and emits to Kafka.
 *
 * The stub itself does nothing — the event has no in-process
 * subscribers in this example. A real app might also use this
 * handler to keep an audit trail or update a local read model.
 */
@Injectable()
@OutboxEventsHandler({
  events: [OrderConfirmedEvent],
  id: 'Orders.OrderConfirmedExternalizationStub',
})
export class OrderConfirmedExternalizationStub
  implements IOutboxEventHandler<OrderConfirmedEvent>
{
  async handle(_event: OrderConfirmedEvent): Promise<void> {
    // Empty body — only here to register a listener for
    // OrderConfirmedEvent so the publication is created and the
    // worker can route it through the externalizer.
  }
}
