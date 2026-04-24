# Outbox Integration with `@nestjs/cqrs`

`@nestjs-transactional/cqrs` bridges `@nestjs/cqrs`'s
`AggregateRoot` pattern with the Event Publication Registry from
`@nestjs-transactional/outbox-core`. A single
`aggregate.commit()` call fans out to both the in-memory
phase-aware dispatcher AND (when wired) the durable outbox, with
automatic de-duplication so each listener runs exactly once.

## The three listener flavours

The package ships three listener decorators, each with a distinct
delivery guarantee. They coexist in the same application and can
even target the same event — the runtime routes each method to the
single path appropriate to its decorators.

| Decorator | Where it lives | Delivery | Retry | Survives crash? | Transaction |
| --- | --- | --- | --- | --- | --- |
| `@TransactionalEventsListener` | cqrs | In-memory, phase-aware | No | No | Joins the publishing tx's lifecycle |
| `@OutboxEventListener` | outbox-core | Persistent, via worker | Yes (operator) | Yes | `REQUIRES_NEW` by default |
| `@ApplicationModuleListener` | cqrs | Outbox if wired, else in-memory fallback | Yes if outbox wired | Yes if outbox wired | `REQUIRES_NEW` |

All three decorators are **metadata-only**: they write a Reflect
metadata entry on the decorated method and do no runtime work at
decoration time. Actual dispatch is performed by scanners and
dispatchers wired by the modules.

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
      │         AFTER_COMMIT hook — listeners fire in-process after
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

## Exactly-once delivery with `@ApplicationModuleListener`

`@ApplicationModuleListener` is a composite decorator: it writes
BOTH outbox listener metadata (via a shared `Symbol.for(...)` key)
AND in-memory listener metadata (`AFTER_COMMIT`, `async: true`) on
the same method. Naïvely, a publish would invoke the method twice:
once via the in-memory dispatcher, once via the worker.

To prevent double-invocation, `TransactionalListenerScanner` in
cqrs injects `OUTBOX_PUBLICATION_SCHEDULER` with `@Optional()`. At
bootstrap, for every method it scans:

1. If the method has no in-memory listener metadata → ignore.
2. If it has in-memory metadata AND the outbox scheduler is bound
   AND it also has outbox listener metadata → **skip** the
   in-memory registration. The outbox's own scanner registers the
   method, and the worker delivers it exactly once.
3. Otherwise → register in-memory as usual.

Rule (2) is what makes `@ApplicationModuleListener` a "smart
default" — same decorator, two delivery modes, chosen by module
wiring rather than by decorator choice.

## Metadata co-location

The two metadata entries written by `@ApplicationModuleListener`
stay compatible across packages because they share a
**well-known `Symbol.for(...)` key** (`@nestjs-transactional/outbox-event-listener-metadata`).
`@nestjs-transactional/cqrs` re-derives the same key without
importing any runtime code from `outbox-core`. The metadata shape
is locally duplicated in cqrs and checked at the unit-test level
against outbox-core's real `getOutboxEventListenerMetadata` reader
— if either side drifts, tests fail.

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
through:

- `Symbol.for(...)` metadata keys (write-side — read-side lives
  in outbox-core's scanner).
- The `OUTBOX_PUBLICATION_SCHEDULER` DI token (runtime — a
  structural `OutboxPublicationScheduler` interface in cqrs, with
  outbox-core's `OutboxEventPublisher` satisfying it).

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
class NotificationHandlers {
  @TransactionalEventsListener(OrderPlacedEvent)
  onOrderPlacedInMemory(e: OrderPlacedEvent): void {
    this.metrics.increment('orders.placed');   // cheap, in-process
  }
}

@Injectable()
class IntegrationHandlers {
  @ApplicationModuleListener(OrderPlacedEvent)
  async shipOrder(e: OrderPlacedEvent): Promise<void> {
    await this.shipping.createShipment(e.orderId);  // durable
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
      registers every `@TransactionalEventsListener` for the event
      type as a hook on the current transaction's appropriate
      phase list (`AFTER_COMMIT`, `BEFORE_COMMIT`, etc.).
      `@ApplicationModuleListener` methods would be registered
      here too if the scanner had not skipped them; with the
      outbox wired, only the pure
      `@TransactionalEventsListener`'d `onOrderPlacedInMemory` is
      on the list.

   b. `outboxScheduler.scheduleForPublication(event)` — buffers
      the event on a per-transaction buffer. On first call per
      transaction, registers ONE `beforeCommit` hook that flushes
      the whole buffer via `outboxPublisher.publishAll(...)`.
      `publishAll` writes one `event_publication` row per
      registered outbox listener (both plain `@OutboxEventListener`
      and `@ApplicationModuleListener` count here).

3. The transaction's `beforeCommit` hooks fire. The outbox flush
   hook runs and inserts the `event_publication` rows. If any
   hook throws, the transaction rolls back and no rows are
   inserted.

4. The transaction commits. Business rows AND publication rows are
   now durable.

5. The `afterCommit` hooks fire synchronously, invoking the
   `@TransactionalEventsListener` methods (`onOrderPlacedInMemory`
   in the example). These run in-process with no durability
   guarantee — a crash between commit and invocation silently
   drops them. Which is fine, because the example metric-increment
   is both cheap and losable.

6. Elsewhere — in the same process if `OutboxProcessingModule` is
   imported, or in a separate worker — the
   `EventPublicationProcessor` polls, claims the new
   `PUBLISHED` rows (`tryClaim`), invokes the outbox listeners
   (`shipOrder` in the example, in a fresh `REQUIRES_NEW`
   transaction), and marks the rows `COMPLETED`. A listener
   failure marks the row `FAILED` — an operator resubmit or the
   startup recovery will move it back into the queue later.

## Failure scenarios

**Publishing transaction rolls back.** The `beforeCommit` outbox
hook either ran (and its inserts roll back with the transaction)
or did not run (the transaction rolled back before reaching it).
Either way, no `event_publication` rows exist and no listener runs.

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

**Listener throws persistently.** The row cycles through `FAILED`
and can be inspected via `FailedEventPublications.findAll()`. The
operator API exposes `resubmit(ResubmissionOptions)` for
controlled retry, with batch size / max attempts / custom filter.

## Further reading

- [Outbox pattern overview](outbox-pattern.md)
- [ADR-006 — Outbox rationale](../adr/006-outbox-pattern.md)
- [`@nestjs-transactional/cqrs` README, "Outbox integration" section](../../packages/cqrs/README.md#outbox-integration)
- [Phase-aware dispatching](../adr/002-transactional-events-spring-semantics.md) *(planned)*
