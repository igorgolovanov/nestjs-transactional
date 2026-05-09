# multi-datasource-outbox

Two TypeORM DataSources, **each with its own complete outbox stack**,
backed by two distinct Postgres databases. Demonstrates the production
multi-DS shape: per-DS `event_publication` table, per-DS worker, per-DS
`forFeature(...)`, decorator-driven handler routing (Phase 14.3.1
Category A — auto-resolves owning DS from the per-DS
`EventTypeRegistry`).

Single-unit atomicity (DD-019) holds **per dataSource**: a billing
transaction commits its `invoices` row and its `event_publication` row
into the billing database in one transaction; the inventory database is
untouched. Cross-DS isolation (DD-023): a billing rollback never
affects inventory's outbox, and vice versa.

## When to use this example

- You have two (or more) bounded-contexts each with their own database
  AND each needs durable cross-process event delivery.
- You want to see `OutboxEventPublisher` smart-facade routing (DD-024) —
  one injected publisher, multiple per-DS targets, automatic
  per-event resolution.
- You want a regression template for cross-DS atomicity invariants
  pinned with real Postgres.

For a simpler illustration without the outbox layer see
[`multi-datasource-basic`](../multi-datasource-basic). For a
single-DS production-shape outbox see
[`basic-typeorm-outbox`](../basic-typeorm-outbox).

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** testcontainers
  pulls `postgres:16-alpine` on first run (~30 MB).
- For the `pnpm start` visual demo: two existing Postgres databases
  (one per DS). Defaults: `billing` and `inventory` on `localhost:5432`
  with `postgres/postgres`. Override via env vars (`PGHOST`, `PGPORT`,
  `PGUSER`, `PGPASSWORD`, `PGBILLING`, `PGINVENTORY`).

## Run

```bash
pnpm install                                              # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/multi-datasource-outbox test:integration

# Unit tests (none right now; passWithNoTests for symmetry):
pnpm -C examples/multi-datasource-outbox test

# Visual demo with externally-running Postgres:
createdb billing && createdb inventory                    # one-shot setup
pnpm -C examples/multi-datasource-outbox start
```

## What it shows

1. **Two `TypeOrmModule.forRoot` calls** — billing (default, no `name`)
   and inventory (`name: 'inventory'`). Each registers its own
   `DataSource` connecting to its own Postgres database.
2. **Two `TypeOrmTransactionalModule.forRoot` calls** — `isDefault: true`
   and `dataSource: 'inventory'`. Per-DS adapter registration.
3. **Two `OutboxTypeOrmModule.forRoot` calls** — each resolves the
   matching DataSource via `getDataSourceToken(name)` and registers a
   per-DS `TypeOrmEventPublicationRepository`.
4. **Two `OutboxModule.forRoot` calls** (ADR-019 multi-`forRoot`) —
   each wires its own per-DS scheduler, processor, staleness monitor.
5. **Two `OutboxModule.forFeature` calls** registering domain events
   to their owning DS — `InvoiceCreatedEvent` to default,
   `StockAdjustedEvent` to inventory.
6. **`@OutboxEventsHandler` classes carry no `dataSource` option** —
   Phase 14.3.1 Category A scanner walks every per-DS
   `EventTypeRegistry`, finds which DS owns each handler's events, and
   registers the listener with that DS's registry. Single source of
   truth: the `forFeature` registration.
7. **`OutboxEventPublisher` smart facade** — DD-024 active-context
   routing detects whether the caller's `@Transactional` scope is
   billing or inventory and dispatches the publication into the right
   DS's outbox automatically. Services inject a single
   `OutboxEventPublisher`; no per-DS variants.
8. **Atomicity per DS** — INSERT into `invoices` + INSERT into
   `event_publication` (both in the billing DB) commit together or
   roll back together.
9. **Cross-DS isolation** — billing rollback discards both billing rows
   and leaves inventory's transaction untouched (DD-023).

## Key files

- [`src/billing.service.ts`](src/billing.service.ts) +
  [`src/inventory.service.ts`](src/inventory.service.ts) — services
  with `@InjectRepository(Entity, dataSource?)` and
  `@InjectOutboxPublisher()` (single facade).
- [`src/billing.handler.ts`](src/billing.handler.ts) +
  [`src/inventory.handler.ts`](src/inventory.handler.ts) — class-level
  `@OutboxEventsHandler({ events, id })` listeners. No `dataSource`
  option — auto-routed by Phase 14.3.1 scanner.
- [`src/events.ts`](src/events.ts) — `InvoiceCreatedEvent` +
  `StockAdjustedEvent` domain events.
- [`src/app.module.ts`](src/app.module.ts) — multi-`forRoot` wiring
  for all four module families (`TypeOrmModule`,
  `TypeOrmTransactionalModule`, `OutboxTypeOrmModule`, `OutboxModule`)
  plus `OutboxModule.forFeature` × 2 for per-DS event registration.
- [`test/multi-ds-outbox.integration.spec.ts`](test/multi-ds-outbox.integration.spec.ts)
  — testcontainers Postgres + `CREATE DATABASE inventory_db` + four
  jest tests pinning per-DS atomicity, per-DS rollback, cross-DS
  isolation in both directions.

## Common pitfalls

- **A separate physical database (or Postgres schema) per DataSource.**
  Two `DataSource` instances pointing at the SAME database mean their
  `event_publication` writes commit independently — the atomicity
  contract assumes one transaction per dataSource. For schema-based
  separation (one Postgres, two schemas) see
  [`shared-database-modular-monolith`](../shared-database-modular-monolith)
  *(planned)*.
- **`OutboxModule.forFeature(events, { dataSource })` is authoritative.**
  Registering `StockAdjustedEvent` to the default DS by mistake routes
  every `@OutboxEventsHandler` for it through the billing registry —
  the publication row would land in the wrong DB. Phase 14.3.1's
  scanner throws at bootstrap if a handler subscribes to events spanning
  multiple DSes (cross-DS handlers must be split per-DS).
- **`OutboxProcessingModule` belongs in the worker process.** API
  processes that only publish should NOT import it — both per-DS
  workers would compete with the dedicated worker for rows. This
  example imports it for single-process demo simplicity.
- **`TypeOrmTransactionalModule.resetForTesting()` /
  `TransactionalModule.resetForTesting()` /
  `OutboxModule.resetForTesting()` between tests when each test rebuilds
  the module from scratch.** Multi-`forRoot` dedup uses static class
  storage; without reset, the second test sees "dataSource already
  registered" and throws.

## Related examples

- [`multi-datasource-basic`](../multi-datasource-basic) — same two
  DataSources, no outbox. Start there if `@Transactional` alone is
  enough.
- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — single-DS
  production-shape outbox. Same atomicity contract, simpler shape.
- [`multi-datasource-cqrs`](../multi-datasource-cqrs) *(planned)* —
  same two DataSources with `@nestjs/cqrs` handlers per dataSource
  (Phase 14.3.1 Category B in-memory dispatcher).
- [`shared-database-modular-monolith`](../shared-database-modular-monolith)
  *(planned)* — same physical Postgres, separate schemas per module.

## Further reading

- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
  (Phase 14.3.1 addendum documents Category A scanner)
- [ADR-019 — outbox multi-`forRoot` pattern](../../docs/adr/019-outbox-multi-forroot-pattern.md)
- [DD-019 single-unit atomicity](../../CLAUDE.md), [DD-023 per-DS
  contexts](../../CLAUDE.md), [DD-024 smart facade](../../CLAUDE.md)
- Atomicity regression tests at the package level:
  [`packages/outbox-typeorm/test/integration/atomicity.integration.spec.ts`](../../packages/outbox-typeorm/test/integration/atomicity.integration.spec.ts),
  [`packages/outbox-typeorm/test/integration/multi-datasource-outbox.integration.spec.ts`](../../packages/outbox-typeorm/test/integration/multi-datasource-outbox.integration.spec.ts).
