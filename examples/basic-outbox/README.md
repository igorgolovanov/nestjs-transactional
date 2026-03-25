# basic-outbox

Foundational outbox example: publish a domain event from a `@Transactional`
method, deliver it to an `@OutboxEventsHandler` after the transaction
commits. **No database, no Docker** — uses the in-memory test adapter
and the default in-memory event publication repository.

For the full Postgres-backed end-to-end picture see `basic-typeorm-outbox`.

## When to use this example

- You want to see the outbox API surface (publish, handler, processor)
  without a database in the way.
- You want a regression test template for outbox-publishing services.
- You are evaluating whether the outbox pattern fits your use case before
  committing to the persistence dependency.

## Run

```bash
pnpm install                                  # from monorepo root
pnpm -C examples/basic-outbox start            # visual demo (main.ts)
pnpm -C examples/basic-outbox test             # jest regression tests
```

Or from this directory: `pnpm start` / `pnpm test`.

## What it shows

1. `OrderService.placeOrder` runs inside `@Transactional()` and calls
   `outbox.publish(new OrderPlacedEvent(...))`. The publication entry
   is written through `EventPublicationRegistry` → repository.
2. After the transaction commits, the `EventPublicationProcessor` worker
   picks up the entry, deserializes the event, and invokes
   `ShippingHandler.handle()` inside a fresh `REQUIRES_NEW` transaction.
3. `OrderService.placeOrderAndFail` publishes an event, then throws.
   The transaction rolls back, and the in-memory repository's
   `afterRollback` hook removes the publication — the event is never
   delivered. **Single-unit atomicity** (DD-019).

Expected `pnpm start` output (interleaved with logger lines):

```
=== basic-outbox ===
1) placeOrder("o-1") inside @Transactional + outbox.publish
[...] LOG [ShippingHandler] Creating shipment for order o-1 (alice@example.com)
   shipping handled: [ 'o-1' ]
2) placeOrderAndFail("o-2") — service throws after publish
   caught: simulated failure after publish — should roll back
   shipping handled (still): [ 'o-1' ]
   expected: o-2 is NOT delivered — publish rolled back with the tx
```

## Key files

- [`src/order-placed.event.ts`](src/order-placed.event.ts) — the domain
  event class registered with `OutboxModule.forFeature(...)`.
- [`src/order.service.ts`](src/order.service.ts) — publishes inside a
  `@Transactional()` method via `OutboxEventPublisher.publish`.
- [`src/shipping.handler.ts`](src/shipping.handler.ts) —
  `@OutboxEventsHandler({ events: [OrderPlacedEvent], id: ... })` class.
- [`src/app.module.ts`](src/app.module.ts) — wiring
  (`InMemoryTransactionAdapter`, `OutboxModule.forRoot/forFeature`,
  `OutboxProcessingModule`).
- [`test/order.service.spec.ts`](test/order.service.spec.ts) — jest tests
  for AFTER_COMMIT delivery + rollback non-delivery.

## Common pitfalls

- **`outbox.publish(event)` must be called inside an active
  `@Transactional()` method.** Without an active transaction the call
  throws `IllegalTransactionStateError` — by design, so the publication
  row commits atomically with the business write.
- **Use a stable listener `id` on `@OutboxEventsHandler`** if you intend
  to rename the class later. The default `id` is the class name, and
  publication rows in the repo carry the listener id; renaming the class
  invalidates pending rows.
- **The default in-memory repository is test-only.** Production deploys
  use `outbox-typeorm` (see `basic-typeorm-outbox` for the wiring).
- **Don't import `OutboxProcessingModule` in API processes** — it
  auto-starts the worker. Only the dedicated worker process should
  import it. This example is single-process for demo purposes.

## Related examples

- [`basic-transactional`](../basic-transactional) — `@Transactional()`
  alone, no events, with TypeORM transparent repositories.
- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — same outbox API,
  but with Postgres + testcontainers showing real durability.
- [`basic-cqrs`](../basic-cqrs) — `@CommandHandler` +
  `@TransactionalEventsHandler` (in-memory phase-aware delivery, no outbox).

## Further reading

- [ADR-006 — outbox pattern rationale](../../docs/adr/006-outbox-pattern.md)
- [ADR-007 — outbox architecture](../../docs/adr/007-outbox-architecture.md)
- [ADR-014 — class-level handler API](../../docs/adr/014-handler-api-redesign.md)
- [`docs/architecture/outbox-pattern.md`](../../docs/architecture/outbox-pattern.md)
