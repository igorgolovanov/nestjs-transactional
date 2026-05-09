# externalization-multi-datasource

Multi-DataSource outbox **combined** with multi-broker externalization
— two physical Postgres databases, two `ClientProxy` registrations,
single global `MicroservicesEventExternalizer`. The "real production
scenario" combination of Tier 2 multi-DS and Tier 3 externalization.

| DataSource | Postgres DB | Event | Broker token | Queue |
|---|---|---|---|---|
| default (billing) | `billing` | `InvoicePaidEvent` | `BILLING_BROKER` | `billing.events` |
| `'inventory'` | `inventory` | `ReservationPlacedEvent` | `INVENTORY_BROKER` | `inventory.events` |

The example uses ONE RabbitMQ broker with two queues for simplicity;
real deployments often have separate brokers per domain (e.g. billing
on a regulated cluster, inventory on a high-throughput one). The
routing pattern is identical either way — `@Externalized({ client })`
selects the `ClientProxy` and that's it.

## When to use this example

- You have multiple DataSources (modular monolith, audit-store split,
  ORM migration, ...) AND need durable broker delivery for events
  out of any of them.
- You want a regression template covering BOTH multi-`OutboxModule.
  forRoot()` (ADR-019) AND per-event `@Externalized({ client })`
  routing in one suite.
- You need to validate the orthogonality claim: which DS owns the
  publication row is independent of which broker the event ends up
  on.

For the multi-DS pattern WITHOUT externalization see
[`multi-datasource-outbox`](../multi-datasource-outbox). For the
multi-broker pattern within a single DS see
[`externalization-multi-broker`](../externalization-multi-broker).

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.**
  - The integration test uses `@testcontainers/postgresql` to spin up
    one Postgres instance; the test creates the `inventory_db` second
    database via the admin connection (`testcontainers`' default user
    has CREATEDB).
  - The visual demo (`pnpm start`) needs a running Postgres with
    BOTH `billing` and `inventory` databases plus a running RabbitMQ
    broker. `docker-compose up -d` brings both up; `docker-init-postgres.sh`
    runs once on first start to create the second database.

## Run

```bash
pnpm install                                                         # from monorepo root

# Integration tests (Docker required for testcontainers Postgres):
pnpm -C examples/externalization-multi-datasource test:integration

# Unit tests (none right now; passWithNoTests for symmetry):
pnpm -C examples/externalization-multi-datasource test

# Visual demo against real Postgres × 2 + RabbitMQ:
docker-compose -f examples/externalization-multi-datasource/docker-compose.yml up -d
pnpm -C examples/externalization-multi-datasource start
docker-compose -f examples/externalization-multi-datasource/docker-compose.yml down -v
```

## Architectural shape

```
   BillingService.payInvoice()                  InventoryService.placeReservation()
   @Transactional() (default DS)                @Transactional({ dataSource: 'inventory' })
        |                                              |
        v                                              v
  +-----+---------------+              +---------------+-----+
  |   BILLING DB        |              |   INVENTORY DB      |
  |  (default DS)       |              |  ('inventory' DS)   |
  | invoices            |              | reservations        |
  | event_publication   |              | event_publication   |
  +-----+---------------+              +---------------+-----+
        |                                              |
   EventPublicationProcessor                  EventPublicationProcessor
   (default DS)                               (inventory DS)
        |                                              |
   BillingPaymentHandler (local)             InventoryAllocationHandler (local)
        |                                              |
        v                                              v
   ┌─────────────────────────────────────────────────────────┐
   │   single MicroservicesEventExternalizer (@Global)       │
   │   reads `metadata.client` per @Externalized event       │
   └────────────────────┬────────────────────────────────────┘
                        |
            +-----------+-----------+
            v                       v
     BILLING_BROKER         INVENTORY_BROKER
     (ClientProxy)          (ClientProxy)
     emit('billing.events') emit('inventory.events')
            |                       |
            v                       v
       +-----------------+  +-----------------+
       | RabbitMQ        |  | RabbitMQ        |
       | billing.events  |  | inventory.events|
       +-----------------+  +-----------------+
```

## Why two `OutboxModule.forRoot()` calls but only one `OutboxMicroservicesModule.forRoot()`

These are deliberately different: per ADR-019 the outbox stack is
**per-DataSource** (one `EventPublicationProcessor`, one
`EventPublicationRepository`, one `EventTypeRegistry`, one
`OutboxListenerRegistry` — per DS). Each DS owns its own publication
table and its own worker.

The externalizer is **process-wide singleton** (Phase 14.6 Q1.A
verification). Multi-broker routing happens via per-event
`@Externalized({ client })` — there is no need for a per-DS
externalizer Map. One `MicroservicesEventExternalizer` is injected
into BOTH per-DS `EventPublicationProcessor`s through the
`@Global()` `EVENT_EXTERNALIZER` token; each processor calls
`externalize(event, metadata)` and the externalizer picks the right
`ClientProxy` based on `metadata.client`.

Practical consequence: adding a third DS later is one extra
`OutboxModule.forRoot({ dataSource })` plus one
`OutboxTypeOrmModule.forRoot({ dataSource })`. Adding a third
broker is one extra `ClientsModule.register([...])` entry plus
`@Externalized({ client: NEW_BROKER })` on the events that should
go there. The two axes don't interact.

## What it shows

1. **Per-DS publication and per-DS worker.** `InvoicePaidEvent`
   commits to the billing DB's `event_publication`; the billing-DS
   `EventPublicationProcessor` picks it up and delivers BOTH
   locally and to BILLING_BROKER.
2. **Per-event broker routing across DSes.** The
   `@Externalized({ client })` decorator on each event class names
   the broker; the externalizer routes accordingly. DSes never
   "spill" their events onto sibling brokers.
3. **DD-023 isolation extended end-to-end.** A billing rollback
   never touches the inventory DB; the inventory broker doesn't
   receive the rolled-back event; an inventory rollback is
   symmetric. Cross-DS atomicity is NOT supported (no XA/2PC) —
   cross-DS consistency goes through the outbox.
4. **Per-publication failure isolation across DSes.** When
   BILLING_BROKER's `emit` throws, only the billing DS's
   publication ends up `FAILED`. The inventory DS's publication
   completes independently — single-unit atomicity is per-row, and
   the rows live in different DBs.
5. **Phase 14.3.1 Category A scanner routing.** The
   `OutboxListenerScanner` walks per-DS `EventTypeRegistry`
   instances to bind handlers to the right registry — no manual
   per-DS plumbing in user code.

## Key files

- [`src/clients.ts`](src/clients.ts) — `BILLING_BROKER` /
  `INVENTORY_BROKER` DI tokens.
- [`src/events.ts`](src/events.ts) — both event classes with
  `@Externalized({ client, target })` decorators.
- [`src/billing.service.ts`](src/billing.service.ts) and
  [`src/inventory.service.ts`](src/inventory.service.ts) — services
  bound to default vs `'inventory'` DS, both using class-token
  `OutboxEventPublisher` (smart facade — DD-024 requires this for
  multi-DS).
- [`src/billing.handler.ts`](src/billing.handler.ts) and
  [`src/inventory.handler.ts`](src/inventory.handler.ts) — local
  handlers; Phase 14.3.1 Category A scanner auto-routes them to
  the right per-DS registry based on the event's
  `forFeature` registration.
- [`src/app.module.ts`](src/app.module.ts) — composition root: two
  `TypeOrmModule.forRoot`, two `TypeOrmTransactionalModule.forRoot`,
  two `OutboxTypeOrmModule.forRoot`, two `OutboxModule.forRoot`
  (per-DS), two `OutboxModule.forFeature` (per-DS), single
  `OutboxMicroservicesModule.forRoot({ defaultClient: BILLING_BROKER })`.
- [`docker-compose.yml`](docker-compose.yml) +
  [`docker-init-postgres.sh`](docker-init-postgres.sh) — visual
  demo stack with the second-DB init.
- [`test/multi-ds-externalization.integration.spec.ts`](test/multi-ds-externalization.integration.spec.ts)
  — testcontainers Postgres + two mocked `ClientProxy`s, six
  integration tests covering routing + atomicity + per-publication
  + per-DS + per-broker isolation.

## Common pitfalls

- **`OutboxEventPublisher` MUST be class-token DI in multi-DS
  services.** The `@InjectOutboxPublisher(...)` decorator binds the
  per-DS underlying publisher and bypasses smart-facade routing
  (DD-024). In a single-DS example you wouldn't notice; in multi-DS
  the wrong choice silently sends every event to the default DS's
  publication table regardless of which `@Transactional({ dataSource })`
  scope is active. Both services in this example carry an explicit
  comment about this.
- **One DS must be bound to `'default'`.** Phase 14.3 binds the
  outbox class-token aliases (e.g. `StartupRecoveryService`) to the
  default-DS's `forRoot` only. Multi-DS deployments pick whichever
  module makes the most sense to be default — billing here.
- **Postgres CREATEDB privilege** for the integration test. The
  testcontainers default user has it; if you swap in a different
  Postgres image with a restricted user, the second-DB creation
  step in `beforeAll` will fail.
- **Cross-DS transactions are NOT supported.** A billing-side
  `@Transactional()` calling into an inventory-side
  `@Transactional({ dataSource: 'inventory' })` opens TWO
  independent transactions. For cross-DS consistency use the
  outbox — that's the contract this example demonstrates.

## Related examples

- [`multi-datasource-outbox`](../multi-datasource-outbox) — same
  multi-DS outbox shape WITHOUT externalization.
- [`externalization-multi-broker`](../externalization-multi-broker)
  — multi-broker pattern within a single DS. Composes with this
  example: one DS, multiple brokers, decorator-driven routing.
- [`shared-database-modular-monolith`](../shared-database-modular-monolith)
  — alternative shape: ONE Postgres DB, two schemas, modular
  sub-modules. Useful if you want logical-only separation rather
  than physical DB isolation.
- [`externalization-with-fallback`](../externalization-with-fallback)
  — ADR-016 silent-success limitation in action and the recovery
  patterns.

## Further reading

- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
- [ADR-019 — outbox multi-`forRoot` pattern](../../docs/adr/019-outbox-multi-forroot-pattern.md)
- [ADR-015 — event externalization architecture](../../docs/adr/015-event-externalization-architecture.md)
- [ADR-016 — externalization reliability semantics](../../docs/adr/016-externalization-reliability-semantics.md)
- [`docs/architecture/event-externalization.md`](../../docs/architecture/event-externalization.md)
