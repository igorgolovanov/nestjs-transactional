# shared-database-modular-monolith

Spring Modulith-style modular monolith — **one Postgres database, two
schemas (`billing` + `inventory`)**, two NestJS sub-modules, two outbox
stacks. Each domain module owns its bounded-context data in its own
schema; cross-module integration runs through the outbox.

The headline observation: schema isolation extends DD-023's per-DS
contract (independent transaction contexts per DataSource) to a
*single physical database*. A billing rollback never touches the
inventory schema; an inventory rollback never touches billing's.

## When to use this example

- Your codebase wants Spring Modulith-style modular boundaries, but you
  don't need (or want) physically separate databases.
- You want per-domain `event_publication` tables — Modulith's "outbox
  per module" pattern — without standing up an extra Postgres instance.
- You want a regression template for cross-schema atomicity invariants
  inside a shared database.

For physically separate databases per DS see
[`multi-datasource-outbox`](../multi-datasource-outbox). For the
single-DS production-shape outbox see
[`basic-typeorm-outbox`](../basic-typeorm-outbox).

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** testcontainers
  pulls `postgres:16-alpine` on first run (~30 MB).
- For the `pnpm start` visual demo: an externally-running Postgres on
  the configured host/port. Defaults: `localhost:5432` /
  `postgres/postgres/postgres`. Override via `PGHOST`, `PGPORT`,
  `PGUSER`, `PGPASSWORD`, `PGDATABASE`. The demo creates the two
  schemas (`billing`, `inventory`) automatically if missing.

## Run

```bash
pnpm install                                                    # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/shared-database-modular-monolith test:integration

# Unit tests (none right now; passWithNoTests for symmetry):
pnpm -C examples/shared-database-modular-monolith test

# Visual demo with externally-running Postgres:
pnpm -C examples/shared-database-modular-monolith start
```

## Architectural shape

```
                 +----------------------------+
                 |       AppModule            |
                 |  (process-wide forRoot)    |
                 +--+----------+--------------+
                    |          |
        +-----------+          +------------+
        |                                   |
   +----v----+                         +----v-----+
   | Billing |                         | Inventory|
   | Module  |                         |  Module  |
   +----+----+                         +----+-----+
        | forFeature([InvoicePaidEvent]),    | forFeature([ReservationPlacedEvent], { dataSource: 'inventory' }),
        | InvoiceRow Repository,             | ReservationRow Repository,
        | BillingService,                    | InventoryService,
        | BillingPaymentProjectionListener   | InventoryShipmentProjectionListener
        |                                    |
        +-----------+      +-----------------+
                    |      |
                  +-v------v-+
                  | Postgres  |  (one physical instance)
                  +-----------+
                    |        |
              +-----+        +------+
              v                     v
      +----------------+    +-------------------+
      |    billing     |    |     inventory     |
      |   (schema)     |    |     (schema)      |
      +----------------+    +-------------------+
      | invoices       |    | reservations      |
      | event_publication|  | event_publication |
      +----------------+    +-------------------+
```

Both schemas live in ONE Postgres database. TypeORM's `schema:`
DataSource option pins each DS's queries to its own namespace.

## Why `forRoot` lives in `AppModule`, not in sub-modules

NestJS resolves provider graphs eagerly per-module. The
`OutboxListenerScanner` (registered by the first
`OutboxModule.forRoot` call) walks every per-DS `EventTypeRegistry`
at `onModuleInit` to route handlers to their owning DS. If a sibling
sub-module's `forFeature` factory hasn't yet populated its registry
when the scanner fires, scanning fails with "event type not registered
in any dataSource".

Centralising `forRoot` calls at AppModule's level guarantees every
per-DS registry singleton resolves before any sub-module's
`forFeature` factory runs against it — and before any scanner walks
the providers. Sub-modules then hold only:

- `TypeOrmModule.forFeature([...])` — Repository registration
- `OutboxModule.forFeature([...], { dataSource })` — event-type registration
- Service + listener providers

This is the canonical NestJS pattern: infrastructure config in the
root, domain logic in feature modules. Spring Modulith's "module
owns its outbox" stays semantically true — domain code is fully
encapsulated; only the *bootstrap wiring* lives at the root.

## Naming asymmetry: framework "default" + Postgres "billing" schema

The billing module is bound to the framework's *default* DataSource
(DI name `'default'`, no `name:` field). The same DS is configured
with `schema: 'billing'` in TypeORM's `forRoot`. Two reasons:

1. **`StartupRecoveryService` and other class-token outbox aliases
   register only on the default-DS `forRoot` today** — see the
   `useExisting: StartupRecoveryService` provider pattern in
   `OutboxModule.forRoot`. Multi-DS deployments make one of their
   domain modules the default DS to avoid wiring a placeholder
   default-DS outbox.
2. **DI tokens vs Postgres schema are independent concepts.** The
   default DS is a NestJS DI token; the schema is a physical
   namespace. They happen to map 1:1 here but they don't have to.
   Documenting this in the example makes the framework / database
   distinction explicit.

## What it shows

1. Two `TypeOrmModule.forRoot` calls → two `DataSource` instances
   pointing at the SAME Postgres host but different schemas.
2. Both modules' entities are configured for `synchronize: true` — at
   bootstrap, each DS creates its tables in its own schema.
3. `BillingService.payInvoice` writes `billing.invoices` and
   `billing.event_publication` in one transaction; `event_publication`
   row gets `COMPLETED` after the worker dispatches the event.
4. `InventoryService.placeReservation` does the symmetric thing in
   the inventory schema.
5. Cross-schema rollback isolation: a billing rollback discards both
   billing-side rows; the inventory schema is unaffected (DD-023
   extends to schemas).
6. Direct schema-qualified queries (`SELECT id FROM billing.invoices`)
   in the integration tests prove physical-namespace placement.

## Key files

- [`src/billing/`](src/billing) — `InvoiceRow` entity,
  `InvoicePaidEvent`, `BillingService`,
  `BillingPaymentProjectionListener`, `BillingModule`. The default
  DS, mapped to `billing` schema.
- [`src/inventory/`](src/inventory) — symmetric layout for
  inventory; mapped to the named `'inventory'` DS and the
  `inventory` schema.
- [`src/app.module.ts`](src/app.module.ts) — composition root: two
  `TypeOrmModule.forRoot` (with `schema:`), all per-DS `forRoot`
  calls (`TypeOrmTransactionalModule`, `OutboxTypeOrmModule`,
  `OutboxModule`), then sub-modules + `OutboxProcessingModule`.
- [`src/main.ts`](src/main.ts) — env-driven demo with an
  `ensureSchemas` step that runs `CREATE SCHEMA IF NOT EXISTS billing;
  CREATE SCHEMA IF NOT EXISTS inventory;` before bootstrap.
- [`test/modular-monolith.integration.spec.ts`](test/modular-monolith.integration.spec.ts)
  — testcontainers Postgres + 4 jest tests.

## Common pitfalls

- **Schemas must exist before TypeORM's `synchronize`.** Postgres
  refuses to create a table in a non-existent schema. Either
  pre-create with `CREATE SCHEMA` (the test does this; the demo's
  `ensureSchemas` helper does too) or run a migration that creates
  schemas first.
- **`forRoot` calls go to AppModule, not sub-modules.** See "Why
  `forRoot` lives in `AppModule`" above.
- **Cross-schema transactions are NOT supported (DD-023).** A
  billing-side `@Transactional` calling into an inventory-side
  `@Transactional` opens TWO independent transactions. For
  cross-schema consistency use the outbox.
- **One module must be bound to the default DS today.** Phase 14.3
  binds class-token outbox aliases to the default DS only;
  multi-DS-only deployments fail with "StartupRecoveryService
  cannot be resolved". Pick whichever module makes the most sense
  to be the default — billing in this example.
- **Production should NOT use `synchronize: true` for outbox tables.**
  Run the migration shipped with `@nestjs-transactional/outbox-typeorm`
  per schema instead (see its README for details).

## Related examples

- [`multi-datasource-basic`](../multi-datasource-basic) — two
  DataSources, no outbox/CQRS. Cross-DS independence at the simplest
  level.
- [`multi-datasource-outbox`](../multi-datasource-outbox) — same
  outbox shape but with two physically separate databases. Compare
  schema-isolation vs database-isolation trade-offs.
- [`multi-datasource-cqrs`](../multi-datasource-cqrs) — CQRS layer
  on top of multi-DS.

## Further reading

- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
- [ADR-019 — outbox multi-`forRoot` pattern](../../docs/adr/019-outbox-multi-forroot-pattern.md)
- [DD-023 — independent transaction contexts per dataSource](../../docs/dd/023-independent-tx-contexts-per-ds.md)
- [Spring Modulith reference — events and the publication
  registry](https://docs.spring.io/spring-modulith/reference/events.html)
  (the inspiration for the per-module-outbox pattern).
