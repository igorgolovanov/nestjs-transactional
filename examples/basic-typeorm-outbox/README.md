# basic-typeorm-outbox

End-to-end outbox example with **real Postgres**, the TypeORM persistence
backend (`@nestjs-transactional/outbox-typeorm`), and the Phase 14.21
single-unit atomicity invariant pinned by integration tests
(testcontainers).

A successful `@Transactional` method commits the business INSERT and the
`event_publication` row in the **same database transaction**; a thrown
error rolls back both. The worker (`EventPublicationProcessor`) polls
the table with `FOR UPDATE SKIP LOCKED` and dispatches to the
`@OutboxEventsHandler`.

## When to use this example

- You want to see the full production-shape outbox: real Postgres, real
  durability, real worker.
- You want a regression test template for outbox-publishing services
  with testcontainers — same shape as the package's own
  `atomicity.integration.spec.ts`.
- You need an answer to "what does atomicity look like end-to-end?"
  before adopting the outbox pattern.

For a no-database illustration of the same API, see [`basic-outbox`](../basic-outbox).

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** testcontainers
  pulls `postgres:16-alpine` on first run (~30 MB).
- The `pnpm start` demo expects an externally-running Postgres — supply
  connection details via `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
  `PGDATABASE` env vars (defaults: `localhost:5432` /
  `postgres/postgres/postgres`).

## Run

```bash
pnpm install                                            # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/basic-typeorm-outbox test:integration

# Unit tests (none right now; passWithNoTests for symmetry):
pnpm -C examples/basic-typeorm-outbox test

# Visual demo with externally-running Postgres:
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres \
  pnpm -C examples/basic-typeorm-outbox start
```

## What it shows

1. **Atomic commit.** `OrderService.placeOrder` runs `orders.save(...)`
   AND `outbox.publish(...)` inside a single `@Transactional()` method.
   Both rows land in the `orders` table and the `event_publication`
   table at commit time. The Phase 14.21 atomicity invariant: one
   transaction, two rows, single LSN.
2. **Atomic rollback.** `placeOrderAndFail` does the same writes and
   then throws. Neither row is persisted — the publication row is gone,
   so the event is never delivered.
3. **Worker delivery.** `EventPublicationProcessor` polls Postgres,
   deserializes `OrderPlacedEvent`, and invokes
   `ShippingHandler.handle()` inside a `REQUIRES_NEW` transaction.
   On success the row transitions to `PublicationStatus.COMPLETED`;
   on failure it stays `FAILED` for an operator to resubmit
   (`FailedEventPublications.resubmit(id)`).

## Key files

- [`src/order.service.ts`](src/order.service.ts) — `@Transactional()`
  method with both an `@InjectRepository` write and an
  `outbox.publish`. Phase 14.20 transparent repos + Phase 14.21
  atomicity in five lines.
- [`src/shipping.handler.ts`](src/shipping.handler.ts) —
  `@OutboxEventsHandler({ events: [OrderPlacedEvent], id: '...' })`.
- [`src/order-placed.event.ts`](src/order-placed.event.ts) — domain
  event class registered with `OutboxModule.forFeature(...)`.
- [`src/app.module.ts`](src/app.module.ts) — wiring
  (`TypeOrmModule.forRoot/forFeature`, `TransactionalModule.forRoot`,
  `TypeOrmTransactionalModule.forRoot()`,
  `OutboxTypeOrmModule.forRoot()`,
  `OutboxModule.forRoot/forFeature`, `OutboxProcessingModule`).
- [`test/order.service.integration.spec.ts`](test/order.service.integration.spec.ts)
  — testcontainers Postgres integration test pinning atomicity +
  rollback non-delivery + worker dispatch.

## Common pitfalls

- **Production must NOT use `synchronize: true` for outbox tables.**
  This example uses it for one-shot demo simplicity; production runs
  the migration shipped with `@nestjs-transactional/outbox-typeorm`.
- **`OutboxProcessingModule` belongs in the worker process only.** API
  processes that just publish events should NOT import it — the
  processor would compete with the dedicated worker for rows. This
  example is single-process for demo purposes.
- **Listener id stability matters once you ship.** The outbox stores
  rows keyed by listener id (`${ClassName}#${EventName}` by default).
  Renaming a handler class invalidates pending rows. Pin a stable id
  via `@OutboxEventsHandler({ events: [...], id: 'stable-id' })` —
  this example does so.
- **`@InjectEntityManager() em.save(Entity, ...)` is NOT transactional**
  (Phase 14.20 known limitation). Use `@InjectRepository` (this
  example's pattern) or `getCurrentEntityManager()`.
- **Don't import `CqrsModule` directly alongside
  `CqrsTransactionalModule.forRoot()`.** Not relevant here (no CQRS),
  but the rule applies to `basic-cqrs` and `e-commerce-orders`.

## Related examples

- [`basic-transactional`](../basic-transactional) — `@Transactional()`
  on its own, no events, with TypeORM transparent repositories.
- [`basic-outbox`](../basic-outbox) — same outbox API surface but with
  the in-memory test adapter — no Docker, no DB.
- [`basic-cqrs`](../basic-cqrs) — `@CommandHandler` +
  `@TransactionalEventsHandler` (in-memory phase-aware delivery).
- [`e-commerce-orders`](../e-commerce-orders) — Tier 5 flagship
  combining the same TypeORM + outbox shape with `@nestjs/cqrs`
  aggregates, multi-DataSource saga, and Kafka externalization.

## Further reading

- [ADR-006 — outbox pattern rationale](../../docs/adr/006-outbox-pattern.md)
- [ADR-007 — outbox architecture](../../docs/adr/007-outbox-architecture.md)
- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
  (Phase 14.20 + Phase 14.21 addenda)
- [`docs/architecture/outbox-pattern.md`](../../docs/architecture/outbox-pattern.md)
- Atomicity regression test that pins the same contract at the package
  level: [`packages/outbox-typeorm/test/integration/atomicity.integration.spec.ts`](../../packages/outbox-typeorm/test/integration/atomicity.integration.spec.ts).
