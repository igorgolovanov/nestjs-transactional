# multi-datasource-cqrs

Two TypeORM DataSources (`billing` + `inventory`) wired with
`@nestjs/cqrs` integration. Each DataSource owns one bounded-context
aggregate (`Invoice` / `Reservation`); each
`@TransactionalEventsHandler` listener carries a `dataSource` option
that pins it to the right DS's transaction context — the headline
demonstration of **Phase 14.3.1 Category B** (cqrs in-memory
dispatcher per-DS hook attachment).

Backed by SQLite in-memory (via `sql.js`) — same shape as
`cqrs-full-stack` plus a second DataSource. No Docker required.

## When to use this example

- You have multiple DataSources AND you use `@nestjs/cqrs` aggregates
  / phase listeners. Single source of truth: one decorator option
  binds a listener to the right DS's transaction.
- You want to see the difference between Phase 14.3.1 Category A
  (auto-routing for outbox-backed handlers — see
  [`multi-datasource-outbox`](../multi-datasource-outbox)) and
  Category B (explicit `dataSource` decorator for cqrs in-memory
  handlers).
- You want a regression template for cross-DS CQRS service tests
  exercising commit, rollback, and cross-DS isolation.

For single-DS CQRS see [`basic-cqrs`](../basic-cqrs). For multi-DS
without CQRS see [`multi-datasource-basic`](../multi-datasource-basic).
For durable cross-DS event delivery see
[`multi-datasource-outbox`](../multi-datasource-outbox).

## Run

```bash
pnpm install                                          # from monorepo root
pnpm -C examples/multi-datasource-cqrs start           # visual demo (main.ts)
pnpm -C examples/multi-datasource-cqrs test            # jest regression tests
```

Or from this directory: `pnpm start` / `pnpm test`.

## What it shows

1. **Two `TypeOrmModule.forRoot` calls** — billing (default) and
   inventory (named). Each backs one aggregate.
2. **Two `TypeOrmTransactionalModule.forRoot` calls** —
   `isDefault: true` and `dataSource: 'inventory'` (ADR-018
   multi-`forRoot`).
3. **One `CqrsTransactionalModule.forRoot()` call** — the cqrs module
   is dataSource-agnostic. Its dispatcher inspects each listener's
   `dataSource` option at bootstrap and attaches AFTER_COMMIT hooks
   to the matching per-DS transaction context.
4. **`IssueInvoiceHandler`** — `@CommandHandler(IssueInvoiceCommand)`
   with `@Transactional()` (default DS = billing). Saves the
   invoice row, calls `aggregate.commit()` to enqueue
   `InvoiceIssuedEvent` as an AFTER_COMMIT hook.
5. **`PlaceReservationHandler`** —
   `@CommandHandler(PlaceReservationCommand)` with
   `@Transactional({ dataSource: 'inventory' })`. Same shape but
   targets the inventory DS.
6. **`BillingNotificationListener`** — default-DS phase listener
   (no `dataSource` option needed — `'default'` is implicit).
7. **`InventoryNotificationListener`** —
   `@TransactionalEventsHandler({ events: [...], dataSource: 'inventory' })`.
   Phase 14.3.1 Category B: dispatcher uses
   `TransactionContext.getActiveTransactionByDataSource('inventory')`
   to attach the hook to the inventory transaction's hook list.
8. **Cross-DS rollback isolation** (DD-023) — a billing rollback
   does not skip inventory's listeners (and vice versa). The
   regression test pins this with a successful billing command
   followed by a failed inventory command.

Expected `pnpm start` output:

```
[...] LOG [TransactionalMethodsBootstrap] Wrapped 0 @Transactional methods
[...] LOG [CqrsHandlerWrapper] Wrapped 2 CQRS handlers with @Transactional
=== multi-datasource-cqrs ===
1) IssueInvoiceCommand("inv-1") — billing tx commits, billing listener fires
[...] LOG [BillingNotificationListener] AFTER_COMMIT (billing) — notifying for invoice inv-1
   billing notified: [ 'inv-1' ]
   inventory notified (untouched): []
2) PlaceReservationCommand("res-1") — inventory tx commits (Phase 14.3.1 Cat B)
[...] LOG [InventoryNotificationListener] AFTER_COMMIT (inventory) — notifying for reservation res-1
   inventory notified: [ 'res-1' ]
   billing notified (still): [ 'inv-1' ]
3) IssueInvoiceCommand("inv-2", shouldFail=true) — billing rolls back
   caught: billing rollback — AFTER_COMMIT skipped, invoice row discarded
   billing notified (inv-2 absent): [ 'inv-1' ]
4) PlaceReservationCommand("res-2", shouldFail=true) — inventory rolls back
   caught: inventory rollback — AFTER_COMMIT skipped, reservation row discarded
   inventory notified (res-2 absent): [ 'res-1' ]
   billing notified (still): [ 'inv-1' ]
   expected: cross-DS rollback isolation — neither side affected (DD-023)
```

## Why the `dataSource` option matters

Without Phase 14.3.1 Category B, the cqrs in-memory dispatcher
attached AFTER_COMMIT hooks via
`TransactionManager.registerBeforeCommit` — which targets "the
first active transaction in the context". In a single-DS app that's
fine. In a multi-DS app where two transactions are concurrently
active, "first" is non-deterministic — and a hook for an inventory
listener could end up attached to a billing transaction, firing on
billing commit even when inventory rolled back (or vice versa).

The `dataSource` decorator option fixes the routing. The dispatcher
now attaches the hook directly onto the listener-bound DS's
transaction's hook list (bypassing the manager's first-active-tx
semantics) — same pattern as
`DataSourceOutboxPublisher.scheduleForPublication`.

## Key files

- [`src/invoice.aggregate.ts`](src/invoice.aggregate.ts) +
  [`src/reservation.aggregate.ts`](src/reservation.aggregate.ts) —
  one `AggregateRoot` per dataSource with one event each.
- [`src/issue-invoice.handler.ts`](src/issue-invoice.handler.ts) —
  `@CommandHandler` with `@Transactional()` (default DS).
- [`src/place-reservation.handler.ts`](src/place-reservation.handler.ts)
  — `@CommandHandler` with `@Transactional({ dataSource: 'inventory' })`.
- [`src/billing.listener.ts`](src/billing.listener.ts) +
  [`src/inventory.listener.ts`](src/inventory.listener.ts) — phase
  listeners. Inventory carries `dataSource: 'inventory'`; billing
  defaults to `'default'`.
- [`src/app.module.ts`](src/app.module.ts) — multi-`forRoot` wiring.
- [`test/multi-ds-cqrs.spec.ts`](test/multi-ds-cqrs.spec.ts) — five
  jest tests for routing, rollback within DS, cross-DS isolation,
  multi-command independence.

## Common pitfalls

- **Do NOT import `CqrsModule` directly alongside
  `CqrsTransactionalModule.forRoot()`.** The transactional module
  imports `CqrsModule` internally and overrides the `EventPublisher`
  DI token; a duplicate import shadows the override and aggregate
  events bypass the dispatcher (CLAUDE.md convention #6).
- **Listeners that subscribe to events from a non-default DS MUST
  pass `dataSource` explicitly.** Without it the dispatcher attaches
  to the default DS's transaction — wrong target. A default-DS
  listener can omit the option (`'default'` is implicit).
- **`@TransactionalEventsHandler` is in-memory and process-local.**
  If the process crashes between `commit()` and the AFTER_COMMIT
  hook running, the event is lost. For durable cross-process
  delivery use `@OutboxEventsHandler` (see
  [`multi-datasource-outbox`](../multi-datasource-outbox)).
- **Cross-DS transactions are NOT supported (DD-023).** A
  `@Transactional({ dataSource: 'billing' })` method that calls into
  a `@Transactional({ dataSource: 'inventory' })` method will run
  TWO independent transactions; if billing rolls back, inventory
  has already committed. For cross-DS consistency use the outbox.
- **`TransactionalModule.resetForTesting()` /
  `TypeOrmTransactionalModule.resetForTesting()` between tests when
  each test rebuilds the module from scratch.** Multi-`forRoot` dedup
  uses static class storage.

## Phase 14.3.1 Category A vs Category B

| Aspect | Category A (outbox) | Category B (cqrs in-memory) |
|---|---|---|
| Decorator | `@OutboxEventsHandler` / `@IntegrationEventsHandler` | `@TransactionalEventsHandler` / `@IntegrationEventsHandler` (in-memory path) |
| Routing source | Per-DS `EventTypeRegistry` (auto-resolved by scanner) | Explicit `dataSource` decorator option |
| Why | Each event class is registered to ONE DS via `forFeature` — single source of truth | cqrs is decoupled from outbox, no per-DS event registry to consult |
| Example | [`multi-datasource-outbox`](../multi-datasource-outbox) | this example |

## Related examples

- [`basic-cqrs`](../basic-cqrs) — single DataSource, all three handler
  types (`@CommandHandler` + `@QueryHandler` + `@TransactionalEventsHandler`).
  Start there for CQRS basics.
- [`multi-datasource-basic`](../multi-datasource-basic) — same two
  DataSources without CQRS or outbox.
- [`multi-datasource-outbox`](../multi-datasource-outbox) — durable
  variant: each DS has its own outbox + Postgres `event_publication`
  table.
- [`cqrs-full-stack`](../cqrs-full-stack) — single DS with multiple
  phase listeners and projection rollback handler.

## Further reading

- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
  (Phase 14.3.1 addendum documents Category A/B framing)
- [DD-023 — independent transaction contexts per
  dataSource](../../CLAUDE.md)
- [`docs/architecture/cqrs-integration.md`](../../docs/architecture/cqrs-integration.md)
- Multi-DS cqrs regression test at the package level:
  [`packages/cqrs/src/module/cqrs-transactional.module.multi-datasource.spec.ts`](../../packages/cqrs/src/module/cqrs-transactional.module.multi-datasource.spec.ts).
