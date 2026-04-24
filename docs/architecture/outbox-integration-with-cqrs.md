# Outbox Integration with `@nestjs/cqrs`

`@nestjs-transactional/cqrs` bridges `@nestjs/cqrs`'s
`AggregateRoot` pattern with the Event Publication Registry from
`@nestjs-transactional/outbox-core`. A single
`aggregate.commit()` call fans out to both the in-memory
phase-aware dispatcher AND (when wired) the durable outbox, with
automatic routing so each handler runs exactly once.

## The three handler flavours

The stack ships three class-level handler decorators, each with a
distinct delivery guarantee. They coexist in the same application
and can even target the same event — the runtime routes each class
to the single path appropriate to its decorator.

| Decorator | Where it lives | Delivery | Retry | Survives crash? | Transaction |
| --- | --- | --- | --- | --- | --- |
| `@TransactionalEventsHandler` | cqrs | In-memory, phase-aware | No | No | Joins the publishing tx's lifecycle |
| `@OutboxEventsHandler` | outbox-core | Persistent, via worker | Yes (operator) | Yes | `REQUIRES_NEW` by default |
| `@ApplicationModuleHandler` | cqrs | Outbox if registrar bound, else in-memory fallback | Yes if outbox bound | Yes if outbox bound | `REQUIRES_NEW` |

All three decorators are **metadata-only**: they write a Reflect
metadata entry on the decorated class and do no runtime work at
decoration time. Actual dispatch is performed by scanners and
dispatchers wired by the modules. See ADR-014 for the rationale
behind the class-level shape.

## HybridEventPublisher

`CqrsTransactionalModule.forRoot()` wires a single strategy object
— `HybridEventPublisher` — into the DI token that
`@nestjs/cqrs`'s `EventPublisher` resolves. `AggregateRoot.commit()`
ends up routing its emitted events through this strategy:

```
AggregateRoot.commit()
      │
      ▼
HybridEventPublisher.publish(event)
      │
      ├──▶ TransactionalEventDispatcher.scheduleDispatch(event)
      │         attaches the event to the current transaction's
      │         AFTER_COMMIT hook — handlers fire in-process after
      │         the commit succeeds.
      │
      └──▶ OutboxPublicationScheduler.scheduleForPublication(event)
                (only when OUTBOX_PUBLICATION_SCHEDULER is bound)
                buffers the event per transaction; a single
                beforeCommit hook flushes the buffer into
                event_publication rows atomically with the business
                write.
```

The outbox path is bound via a provider:

```ts
{ provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher }
```

Without that provider, `HybridEventPublisher` behaves identically
to `TransactionalEventPublisher` (in-memory only) — the
`@Optional()` injection leaves the outbox half undefined.

## Exactly-once delivery with `@ApplicationModuleHandler`

`@ApplicationModuleHandler` is a standalone class-level decorator
with its own dedicated metadata key. A separate scanner,
`ApplicationModuleHandlerScanner` in the cqrs package, decides the
delivery path at bootstrap:

1. For each provider carrying `@ApplicationModuleHandler` metadata,
   check whether the `OUTBOX_LISTENER_REGISTRAR` DI token is bound.
2. **Bound**: register with the outbox registry (via the structural
   registrar port) with a `REQUIRES_NEW`-wrapped invoke closure.
   Delivery goes through the worker — durable, retried, resumable.
3. **Unbound**: register with `TransactionalEventDispatcher` as an
   `AFTER_COMMIT` + `async: true` hook, wrapping the invocation in
   a fresh transaction to match outbox semantics as closely as
   in-memory dispatch allows.

A single class is registered in exactly ONE path — so the handler
fires exactly once per event. `TransactionalListenerScanner` in cqrs
only scans for `@TransactionalEventsHandler`, so there is no overlap
between the two scanners and no skip-logic is needed.

Rule (2) — the automatic routing based on `OUTBOX_LISTENER_REGISTRAR`
— is what makes `@ApplicationModuleHandler` a "smart default":
same decorator, two delivery modes, chosen by module wiring rather
than by decorator choice.

## Structural ports, no hard dependency

The cqrs package defines both ports as process-local Symbols with a
structural TypeScript interface:

```ts
// cqrs package
export const OUTBOX_PUBLICATION_SCHEDULER = Symbol('OUTBOX_PUBLICATION_SCHEDULER');
export interface OutboxPublicationScheduler {
  scheduleForPublication(event: unknown): void;
}

export const OUTBOX_LISTENER_REGISTRAR = Symbol('OUTBOX_LISTENER_REGISTRAR');
export interface OutboxListenerRegistrar {
  register(listener: { id: string; eventType: string; invoke: (event: unknown) => Promise<void> }): void;
}
```

`@nestjs-transactional/outbox-core` provides implementations that
satisfy these interfaces structurally — `OutboxEventPublisher`
exposes `scheduleForPublication(event)`, `OutboxListenerRegistry`
exposes the `register(...)` shape. Consumers bind the tokens in
their app module when they want outbox delivery:

```ts
providers: [
  { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
  { provide: OUTBOX_LISTENER_REGISTRAR, useExisting: OutboxListenerRegistry },
],
```

This keeps the dependency graph clean:

```
          ┌──────────┐
          │   core   │
          └────┬─────┘
               │
    ┌──────────┼──────────┬───────────────┐
    ▼          ▼          ▼               ▼
  typeorm    cqrs    outbox-core    (other adapters)
                          │
                          ▼
                   outbox-typeorm
```

No arrow from cqrs to outbox-core. The two packages communicate
entirely through DI tokens and structural interfaces.

## End-to-end walkthrough

**Application code:**

```ts
class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class Order extends AggregateRoot {
  place(orderId: string): void {
    this.apply(new OrderPlacedEvent(orderId));
  }
}

@CommandHandler(PlaceOrderCommand)
class PlaceOrderHandler {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(cmd: PlaceOrderCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new Order());
    order.place(cmd.orderId);
    order.commit();
    // persist order via repository...
  }
}

@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
class OrderPlacedMetrics
  implements ITransactionalEventsHandler<OrderPlacedEvent>
{
  constructor(private readonly metrics: Metrics) {}
  handle(e: OrderPlacedEvent): void {
    this.metrics.increment('orders.placed'); // cheap, in-process
  }
}

@Injectable()
@ApplicationModuleHandler(OrderPlacedEvent)
class ShipOrderHandler
  implements IApplicationModuleHandler<OrderPlacedEvent>
{
  constructor(private readonly shipping: ShippingClient) {}
  async handle(e: OrderPlacedEvent): Promise<void> {
    await this.shipping.createShipment(e.orderId); // durable
  }
}
```

**What happens at commit:**

1. `order.commit()` loops over the aggregate's events and calls
   `publisher.publish(event)` for each. `publisher` is the
   `TransactionalEventPublisherAdapter`, which delegates to
   `HybridEventPublisher.publish(event)`.

2. `HybridEventPublisher` does two things per event:

   a. `TransactionalEventDispatcher.scheduleDispatch(event)` —
      registers every `@TransactionalEventsHandler`'d class for the
      event type as a hook on the current transaction's appropriate
      phase list (`AFTER_COMMIT`, `BEFORE_COMMIT`, etc.).
      `@ApplicationModuleHandler` classes are NOT on this list —
      they were routed at bootstrap to either the outbox (when the
      registrar is bound) or to their own dispatcher entry (when
      not), not via this scanner.

   b. `outboxScheduler.scheduleForPublication(event)` — buffers
      the event on a per-transaction buffer. On first call per
      transaction, registers ONE `beforeCommit` hook that flushes
      the whole buffer via `outboxPublisher.publishAll(...)`.
      `publishAll` writes one `event_publication` row per
      registered outbox listener (both plain `@OutboxEventsHandler`
      classes and outbox-routed `@ApplicationModuleHandler` classes
      count here).

3. The transaction's `beforeCommit` hooks fire. The outbox flush
   hook runs and inserts the `event_publication` rows. If any
   hook throws, the transaction rolls back and no rows are
   inserted.

4. The transaction commits. Business rows AND publication rows are
   now durable.

5. The `afterCommit` hooks fire synchronously, invoking the
   `@TransactionalEventsHandler` classes (`OrderPlacedMetrics` in
   the example). These run in-process with no durability
   guarantee — a crash between commit and invocation silently
   drops them. Which is fine, because the example metric-increment
   is both cheap and losable.

6. Elsewhere — in the same process if `OutboxProcessingModule` is
   imported, or in a separate worker — the
   `EventPublicationProcessor` polls, claims the new
   `PUBLISHED` rows (`tryClaim`), invokes the outbox handlers
   (`ShipOrderHandler` in the example, in a fresh `REQUIRES_NEW`
   transaction), and marks the rows `COMPLETED`. A handler
   failure marks the row `FAILED` — an operator resubmit or the
   startup recovery will move it back into the queue later.

## Failure scenarios

**Publishing transaction rolls back.** The `beforeCommit` outbox
hook either ran (and its inserts roll back with the transaction)
or did not run (the transaction rolled back before reaching it).
Either way, no `event_publication` rows exist and no handler runs.

**Worker crashes mid-invocation.** The `event_publication` row
sits in `PROCESSING`. The `StalenessMonitor` detects it's been in
`PROCESSING` past its threshold and flips it to `FAILED`. An
operator or `republishOnStartup: true` on next start restores it
to `RESUBMITTED`, and the next worker poll picks it up for a
fresh attempt.

**Whole process crashes.** Same as the worker case for any
`PROCESSING` rows; additionally, any `PUBLISHED` rows that hadn't
been claimed yet are still ready to go for the next worker. No
data loss as long as the transaction committed before the crash.

**Handler throws persistently.** The row cycles through `FAILED`
and can be inspected via `FailedEventPublications.findAll()`. The
operator API exposes `resubmit(ResubmissionOptions)` for
controlled retry, with batch size / max attempts / custom filter.

## Further reading

- [Outbox pattern overview](outbox-pattern.md)
- [ADR-006 — Outbox rationale](../adr/006-outbox-pattern.md)
- [ADR-014 — Class-level handler API redesign](../adr/014-handler-api-redesign.md)
- [`@nestjs-transactional/cqrs` README, "Outbox integration" section](../../packages/cqrs/README.md#outbox-integration)
