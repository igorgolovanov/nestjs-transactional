# multi-datasource-basic

Foundational multi-DataSource example: two independent TypeORM
DataSources (`billing` + `inventory`) wired through the
ADR-018 multi-`forRoot` pattern, with services routing transactions
via `@Transactional({ dataSource })`.

Backed by SQLite in-memory (via `sql.js`); no Docker required. Demonstrates
**cross-DS isolation** (DD-023) — a transaction on dataSource A does NOT
silently enrol dataSource B.

## When to use this example

- Your app has two (or more) independent databases — separate domains,
  bounded contexts, audit-store split, etc. — and you need transactional
  semantics scoped per database.
- You want to see the canonical multi-DS wiring before adding outbox or
  CQRS (those layer on top — see related examples).
- You want a regression template for cross-DS service tests that exercise
  both happy-path and rollback-isolation cases.

## Run

```bash
pnpm install                                         # from monorepo root
pnpm -C examples/multi-datasource-basic start         # visual demo (main.ts)
pnpm -C examples/multi-datasource-basic test          # jest regression tests
```

Or from this directory: `pnpm start` / `pnpm test`.

## What it shows

1. Two `TypeOrmModule.forRoot` calls — one default (no `name`), one named
   `'inventory'`. Each registers its own `DataSource` in DI under
   `getDataSourceToken()` and `getDataSourceToken('inventory')`.
2. Two `TypeOrmTransactionalModule.forRoot` calls (ADR-018 multi-`forRoot`
   per dataSource): the first marks itself `isDefault: true`, the second
   passes `dataSource: 'inventory'`. Both adapters live under distinct
   per-DS DI tokens.
3. `BillingService.createInvoice` — `@Transactional()` (defaults to the
   `'default'` dataSource → billing). Uses
   `@InjectRepository(InvoiceEntity)` — Phase 14.20 transparent repo.
4. `InventoryService.upsertStock` — `@Transactional({ dataSource: 'inventory' })`
   (DD-020 canonical form). Uses
   `@InjectRepository(StockItemEntity, 'inventory')` — `@nestjs/typeorm`
   derives the per-DS provider token automatically.
5. Cross-DS isolation: the `inventory` rollback test asserts the billing
   row remains untouched (and vice versa) — the rolled-back transaction
   is scoped to its own dataSource only.

Expected `pnpm start` output:

```
[...] LOG [TransactionalMethodsBootstrap] Wrapped 4 @Transactional methods
=== multi-datasource-basic ===
1) createInvoice("inv-1") — @Transactional() → default (billing) adapter
2) upsertStock("sku-1") — @Transactional({ dataSource: "inventory" })

billing rows: [ 'inv-1' ]
inventory rows: [ 'sku-1' ]

Cross-check isolation — neither DB knows the other's entity:
   billing has `stock_items` table? false
   inventory has `invoices` table? false

3) upsertStockAndFail("sku-2") — inventory tx rolls back, billing untouched
   caught: simulated inventory failure — should roll back
   billing rows (still): [ 'inv-1' ]
   inventory rows (sku-2 absent): [ 'sku-1' ]
```

## How multi-DS routing works

Every transaction is tracked in `TransactionContext` (AsyncLocalStorage)
under the dataSource name as the lookup key (DD-023). The two adapter
instances live under independent ALS scopes — there is no shared state
between them by design.

`@Transactional({ dataSource: 'inventory' })` tells the manager to open
a transaction against the `inventory` adapter; the active EntityManager
is registered under that name. Phase 14.20's
`Repository.prototype.manager` getter consults
`TransactionContext.getActiveTransactionByDataSource('inventory')` for
Repositories injected via `@InjectRepository(StockItemEntity, 'inventory')`
— so the same `@Transactional` scope automatically dispatches the right
EntityManager for that dataSource.

## Key files

- [`src/billing.service.ts`](src/billing.service.ts) — `@Transactional()`
  (default DS) with `@InjectRepository(InvoiceEntity)`.
- [`src/inventory.service.ts`](src/inventory.service.ts) —
  `@Transactional({ dataSource: 'inventory' })` with
  `@InjectRepository(StockItemEntity, 'inventory')`.
- [`src/app.module.ts`](src/app.module.ts) — two `TypeOrmModule.forRoot`
  + two `TypeOrmTransactionalModule.forRoot` calls side by side.
- [`src/entities.ts`](src/entities.ts) — `InvoiceEntity` + `StockItemEntity`.
- [`test/multi-datasource.spec.ts`](test/multi-datasource.spec.ts) — jest
  tests for routing, rollback, cross-DS isolation, multiple writes.

## Common pitfalls

- **Default + named DataSources need explicit `name` on the second
  `TypeOrmModule.forRoot`.** `@nestjs/typeorm` auto-discovers
  `@InjectRepository(Entity, dataSourceName)` providers based on the
  `name` field — without it, the second registration overwrites the
  default's Repository tokens.
- **Cross-DS transactions are NOT supported (DD-023).** Calling
  `inventoryService.upsertStock(...)` from inside a billing
  `@Transactional()` method does NOT enrol the inventory write into the
  billing transaction. Each runs in its own scope. The recommended
  pattern for cross-DS consistency is the outbox stack — see
  [`multi-datasource-outbox`](../multi-datasource-outbox).
- **`TransactionalModule.resetForTesting()` /
  `TypeOrmTransactionalModule.resetForTesting()` between tests when each
  test rebuilds the module from scratch.** Multi-`forRoot` dedup uses
  static class storage; without reset, the second test sees "dataSource
  already registered" and throws.
- **`@InjectEntityManager() em.save()` direct call is NOT transactional**
  (Phase 14.20 known limitation). Use `@InjectRepository` (this
  example's pattern) or `getCurrentEntityManager(dataSource)`.

## Related examples

- [`basic-transactional`](../basic-transactional) — single DataSource,
  same `@Transactional` semantics. Start here if multi-DS is overkill.
- [`multi-datasource-outbox`](../multi-datasource-outbox) — adds
  durable cross-DS event integration via the outbox.
- [`multi-datasource-cqrs`](../multi-datasource-cqrs) — adds
  `@nestjs/cqrs` handlers per dataSource (Phase 14.3.1 Category B).
- [`shared-database-modular-monolith`](../shared-database-modular-monolith)
  — same physical Postgres, separate schemas per module.

## Further reading

- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
- [DD-020..024](../../CLAUDE.md) — multi-adapter design decisions
  (dataSource as identifier, per-DS contexts, smart facades)
- [`@nestjs/typeorm` multi-database docs](https://docs.nestjs.com/techniques/database#multiple-databases)
  — the standard NestJS pattern this example builds on.
