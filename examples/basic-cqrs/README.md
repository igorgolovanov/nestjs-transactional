# basic-cqrs

Foundational CQRS example covering all three handler types from
`@nestjs/cqrs`:

- `@CommandHandler` decorated with `@Transactional()` (write path)
- `@QueryHandler` auto-wrapped in a read-only transaction by
  `CqrsTransactionalModule`
- `@TransactionalEventsHandler` firing **only after the surrounding
  transaction commits**

In-memory test adapter, no database — the focus is the
phase-aware-delivery lifecycle and the three handler types working
together, not persistence.

## When to use this example

- You are wiring `@nestjs/cqrs` for the first time and want to see
  `@TransactionalEventsHandler` semantics in isolation.
- You want a regression template for command handlers with
  AFTER_COMMIT side effects.
- You are evaluating the difference between in-memory phase-aware
  delivery (this example) and durable outbox delivery (`basic-outbox`).

For a more involved CQRS setup (TypeORM persistence, multiple phases,
projections, queries) see [`cqrs-full-stack`](../cqrs-full-stack).
For durable cross-process delivery see [`basic-outbox`](../basic-outbox)
and [`basic-typeorm-outbox`](../basic-typeorm-outbox).

## Run

```bash
pnpm install                                # from monorepo root
pnpm -C examples/basic-cqrs start            # visual demo
pnpm -C examples/basic-cqrs test             # jest regression tests
```

Or from this directory: `pnpm start` / `pnpm test`.

## What it shows

1. `PlaceOrderCommand` is dispatched via `CommandBus`. The command
   handler's `execute` method is wrapped with `@Transactional()` —
   `CqrsHandlerWrapper` does this at bootstrap.
2. Inside `execute`, `EventPublisher.mergeObjectContext(new Order(id))`
   retargets `aggregate.commit()` through
   `TransactionalEventPublisher`. Aggregate-emitted events become
   AFTER_COMMIT hooks on the active transaction rather than firing
   immediately on the in-memory `EventBus`.
3. On success, the transaction commits and `NotificationHandler.handle`
   runs.
4. On `shouldFail: true`, the handler throws AFTER `order.commit()` —
   the transaction rolls back, the AFTER_COMMIT hook is discarded,
   `NotificationHandler.handle` is **never invoked**.
5. `GetNotifiedOrdersQuery` is dispatched via `QueryBus`. Its handler
   is auto-wrapped by `CqrsHandlerWrapper` in a `@Transactional()`
   call honouring `defaultQueryOptions: { readOnly: true }` — the
   read-only flag is a hint downstream adapters (TypeORM, Prisma,
   ...) can use to optimize or to refuse writes.

Expected `pnpm start` output:

```
[...] LOG [TransactionalMethodsBootstrap] Wrapped 0 @Transactional methods
[...] LOG [CqrsHandlerWrapper] Wrapped 2 CQRS handlers with @Transactional
=== basic-cqrs ===
1) PlaceOrderCommand("o-1") — succeeds
[...] LOG [NotificationHandler] AFTER_COMMIT — notifying customer for order o-1
   notified after commit: [ 'o-1' ]
2) PlaceOrderCommand("o-2", shouldFail=true) — handler throws
   caught: simulated failure — transaction rolls back, AFTER_COMMIT skipped
   notified (still): [ 'o-1' ]
   expected: o-2 is NOT in the list — AFTER_COMMIT skipped on rollback
3) GetNotifiedOrdersQuery — auto-wrapped in readOnly tx
   query result: [ 'o-1' ]
```

## Key files

- [`src/order.aggregate.ts`](src/order.aggregate.ts) — minimal
  `AggregateRoot` with one event class.
- [`src/place-order.handler.ts`](src/place-order.handler.ts) —
  `@CommandHandler` with `@Transactional()` and
  `EventPublisher.mergeObjectContext` + `aggregate.commit()`.
- [`src/get-notified-orders.query.ts`](src/get-notified-orders.query.ts)
  — `@QueryHandler` auto-wrapped in a read-only transaction.
- [`src/notification.handler.ts`](src/notification.handler.ts) —
  `@TransactionalEventsHandler(OrderPlacedEvent)` (default phase
  `AFTER_COMMIT`).
- [`src/app.module.ts`](src/app.module.ts) — wiring
  (`InMemoryTransactionAdapter` + `CqrsTransactionalModule.forRoot()`).
- [`test/place-order.spec.ts`](test/place-order.spec.ts) — jest tests
  for AFTER_COMMIT delivery + rollback non-delivery + sibling-tx
  isolation.

## Common pitfalls

- **Do NOT import `CqrsModule` directly alongside
  `CqrsTransactionalModule.forRoot()`.** `CqrsTransactionalModule`
  imports `CqrsModule` internally and overrides the `EventPublisher`
  DI token; a duplicate import shadows the override and aggregate
  events bypass the dispatcher (CLAUDE.md convention #6).
- **`@TransactionalEventsHandler` is in-memory and process-local.**
  If the process crashes between `commit()` and the AFTER_COMMIT
  hook running, the event is lost. For durable cross-process
  delivery use `@OutboxEventsHandler` (see `basic-outbox`).
- **One event class — one bound class-level handler.** ADR-014
  enforces single-responsibility. Need multiple side effects? Use
  multiple handler classes.
- **Don't publish events outside a transaction.** Outside any
  active transaction, handlers with `fallbackExecution: true` fire
  immediately; the rest are dropped with a warning. The default
  is "no fallback" — emit from inside `@Transactional()`.

## Phases beyond AFTER_COMMIT

- `BEFORE_COMMIT` — fires before commit; an error rolls the tx back.
  Useful for last-minute validation.
- `AFTER_ROLLBACK` — fires after a rollback; receives the error.
  Useful for compensating actions or observability.
- `AFTER_COMPLETION` — fires on either commit or rollback.

`cqrs-full-stack` demonstrates `AFTER_ROLLBACK` alongside
`AFTER_COMMIT`. The full enum is in
`@nestjs-transactional/cqrs`'s `TransactionPhase`.

## Related examples

- [`basic-transactional`](../basic-transactional) — `@Transactional()`
  on plain services, no CQRS.
- [`basic-outbox`](../basic-outbox) — durable equivalent
  (`@OutboxEventsHandler`), in-memory backend.
- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — durable
  outbox + Postgres + atomicity testcontainers test.
- [`cqrs-full-stack`](../cqrs-full-stack) — TypeORM persistence,
  multiple phases, projection rollback handler, query handler.

## Further reading

- [ADR-002 — transactional events with Spring semantics](../../docs/adr/002-transactional-events-spring-semantics.md)
- [ADR-003 — not patching `@nestjs/cqrs`](../../docs/adr/003-not-patching-nestjs-cqrs.md)
- [ADR-005 — method wrapping strategy](../../docs/adr/005-method-wrapping-strategy.md)
- [ADR-014 — class-level handler API](../../docs/adr/014-handler-api-redesign.md)
- [`docs/architecture/cqrs-integration.md`](../../docs/architecture/cqrs-integration.md)
