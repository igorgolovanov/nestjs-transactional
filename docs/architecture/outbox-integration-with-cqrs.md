# Outbox Integration with `@nestjs/cqrs`

`@nestjs-transactional/cqrs` connects `@nestjs/cqrs`'s `EventBus` to
two delivery paths: the in-memory phase-aware dispatcher, and, when
`@nestjs-transactional/outbox` is wired, the durable outbox delivered by
[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox). One
`aggregate.commit()` reaches both, inside the aggregate's transaction.

## Handlers

| Decorator | From | Delivery | Retry | Survives a crash? | Transaction |
| --- | --- | --- | --- | --- | --- |
| `@TransactionalEventsHandler` | `@nestjs-transactional/cqrs` | In-memory, at a chosen phase | No | No | Joins the publishing transaction's lifecycle |
| `@IntegrationEventsHandler` | `@nestjs-transactional/cqrs` | In-memory, after the commit, async | No | No | A new transaction of its own |
| `@OnOutboxMessage` | `@nestjs/outbox` | Through the outbox relay | Yes, with backoff, then dead letter | Yes | Its own; add `@Transactional()` on the method |

Until 2.x, `@IntegrationEventsHandler` became durable by itself once the
outbox was wired. From 3.0.0 durability belongs to `@nestjs/outbox`, so
that decorator stays in-memory and durable handlers are written with
`@OnOutboxMessage` (ADR-023).

## The EventBus publisher chain

`CqrsTransactionalModule.forRoot()` imports `CqrsModule.forRoot()` with
`TransactionalEventBusPublisher` as the `EventBus`'s publisher
(ADR-024, DD-029). Every event the bus publishes passes through it:

```
aggregate.commit()  /  eventBus.publish(event)
      │
      ▼
EventBus.publish                    inside @Transactional: context becomes
      │                             { transaction, aggregate? }; COMMIT
      │                             waits for what the chain returns
      ▼
(a wrapping publisher, e.g. WorkflowsCqrsModule: @StartOn / @SignalOn
 write through context.transaction, then forward)
      │
      ▼
TransactionalEventBusPublisher.publish(event)
      │
      ├──▶ TransactionalEventDispatcher.scheduleDispatch(event)
      │       in-memory; phase handlers fire at their phase
      │
      ├──▶ OutboxPublicationScheduler.scheduleForPublication(event)
      │       only when OUTBOX_PUBLICATION_SCHEDULER is bound,
      │       and only for @Externalized events: buffered per
      │       transaction and added to @nestjs/outbox by one
      │       before-commit hook, so the messages commit with
      │       the aggregate's writes
      │
      └──▶ @EventsHandler / sagas, at once, inside the transaction
```

`TransactionalOutboxModule.forRoot()` binds
`OUTBOX_PUBLICATION_SCHEDULER` to the bridge's `OutboxEventPublisher`.
No manual provider is needed.

### Which aggregate events reach the outbox

Only those with `@Externalized`. Taking every aggregate event into the
outbox was rejected on measurement: `@nestjs/outbox`'s `local` transport
throws `OutboxNoHandlerError` for a topic nobody subscribes to, so every
event without a durable subscriber would retry and then dead-letter
(DD-028).

An aggregate event that needs durable in-process delivery opts in by
routing to the `local` transport:

```ts
@Externalized<OrderPlaced>({ target: 'orders.placed', client: 'local' })
export class OrderPlaced { ... }

@Injectable()
export class ReserveStock {
  @OnOutboxMessage('orders.placed', { consumer: 'inventory.reserve-stock' })
  @Transactional()
  async reserve(event: OrderPlaced) { ... }
}
```

[`e-commerce-orders`](../../examples/e-commerce-orders) starts its saga
exactly this way.

## Structural ports, no hard dependency

cqrs and the outbox bridge do not import each other. cqrs declares the
port and a structural interface:

```ts
export const OUTBOX_PUBLICATION_SCHEDULER = Symbol.for(
  '@nestjs-transactional/cqrs/outbox-publication-scheduler',
);
export interface OutboxPublicationScheduler {
  scheduleForPublication(event: unknown): void;
}
```

The bridge binds the same `Symbol.for` key. A spec in cqrs fails if its
source ever imports from `@nestjs-transactional/outbox`, so the
decoupling cannot erode unnoticed.

## Failure scenarios

| What fails | Outcome |
| --- | --- |
| The aggregate's transaction rolls back | No in-memory handler fires; no outbox message exists |
| The process dies after the commit | In-memory handlers are lost; the outbox message is delivered after the restart |
| An `@OnOutboxMessage` handler throws | Retried with backoff, dead-lettered after the last attempt |
| `aggregate.commit()` or `eventBus.publish()` outside a transaction | In-memory dispatch follows its fallback rules; an `@Externalized` event is dropped and logged, since a synchronous caller cannot be given the error |

## Further reading

- [ADR-014 — class-level handler API](../adr/014-handler-api-redesign.md)
- [ADR-023 — delivery through `@nestjs/outbox`](../adr/023-delegate-delivery-to-nestjs-outbox.md)
- [ADR-024 — events through the `EventBus`](../adr/024-cqrs-events-through-the-event-bus.md)
- [DD-029 — the publisher chain contract](../dd/029-cqrs-publisher-chain-contract.md)
- [DD-028 — the bridge contract](../dd/028-outbox-bridge-contract.md)
- [Outbox pattern](outbox-pattern.md)
