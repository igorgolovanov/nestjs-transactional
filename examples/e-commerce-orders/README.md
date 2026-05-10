# e-commerce-orders

**Tier 5 flagship.** A realistic order-placement application using
every framework feature at once: three bounded contexts × three
Postgres DataSources × per-DS outbox stack × Kafka externalization
× CQRS aggregate roots × REST API. The intent is "would I deploy
this shape?" rather than "this is the shortest illustration of X."

## When to use this example

- You're starting a new NestJS app on this framework and want a
  copy-paste skeleton with all the moving parts wired up
  correctly.
- You want to see how Tier 1–4 patterns compose: choreographed
  saga (Tier 4), per-DS outbox (Tier 2), externalization (Tier
  3), CQRS aggregate-root commit (`outbox-full-stack` carry-over),
  REST surface (new in Tier 5) — all in one app.
- You're evaluating the framework against a non-trivial
  benchmark.

## Architecture

```
                     POST /orders                GET /orders/:id
                        │                           │
                        ▼                           ▼
                 ┌───────────────────────────────────────┐
                 │   OrdersController (REST)             │
                 └───────────────────────────────────────┘
                        │                           │
                        ▼                           ▼
                 PlaceOrderCommand            GetOrderQuery
                        │                           │
                        ▼                           ▼
                 ┌──────────────┐             ┌──────────────┐
                 │  Orders DS   │             │  Orders DS   │
                 │  ┌────────┐  │             │  (read)      │
                 │  │ orders │  │             └──────────────┘
                 │  └────────┘  │
                 │  outbox      │ OrderPlacedEvent
                 └──────┬───────┘
                        │ choreography via outbox
                        ▼
                 ┌──────────────────┐
                 │  Inventory DS    │
                 │  ┌────────────┐  │
                 │  │ products   │  │ ← decrement available
                 │  │ reservations│ │ ← insert reservation rows
                 │  └────────────┘  │
                 │  outbox          │ StockReservedEvent (or *Failed)
                 └─────┬────────────┘
                       │
                       ▼
                 ┌──────────────────┐
                 │  Billing DS      │
                 │  ┌────────────┐  │
                 │  │ payments   │  │ ← INSERT charged | failed
                 │  └────────────┘  │
                 │  outbox          │ PaymentChargedEvent (or *Failed)
                 └─────┬────────────┘
                       │
                       ▼
                 ┌──────────────────┐
                 │  Orders DS       │
                 │  (confirm step)  │ ← status = 'confirmed'
                 │  outbox          │ OrderConfirmedEvent (@Externalized)
                 └─────┬────────────┘
                       │
                       ▼
                 ┌─────────────────────┐
                 │  Kafka              │
                 │  topic:             │
                 │    orders.confirmed │
                 └─────────────────────┘
```

Compensation flows mirror the happy path:

- `StockReservationFailedEvent` → orders' compensation handler
  marks order `'failed'`.
- `PaymentFailedEvent` → orders' compensation handler marks
  order `'failed'` AND inventory's `ReleaseStockHandler` restores
  the previously-reserved stock.

## Bounded contexts

Each lives in its own folder (`src/{orders,inventory,billing}/`)
with its own NestJS module. Cross-context dependencies happen
ONLY through the shared events (`src/shared/events.ts`) — the
inventory module never imports an orders type and vice versa.

| Context  | Owns                       | Publishes          | Consumes                 |
|----------|----------------------------|--------------------|--------------------------|
| Orders   | `OrderRow`                 | `OrderPlacedEvent`, `OrderConfirmedEvent` | `PaymentChargedEvent` (confirm) + `*FailedEvent` (compensation) |
| Inventory| `ProductRow`, `ReservationRow` | `StockReservedEvent`, `StockReservationFailedEvent` | `OrderPlacedEvent` (reserve) + `PaymentFailedEvent` (release) |
| Billing  | `PaymentRow`               | `PaymentChargedEvent`, `PaymentFailedEvent` | `StockReservedEvent` |

## Externalization

Only ONE event class crosses the system boundary —
`OrderConfirmedEvent`, the terminal happy-path event. It carries
`@Externalized<OrderConfirmedEvent>({ target: 'orders.confirmed',
client: KAFKA_CLIENT, ... })` metadata. The outbox worker delivers
the publication, the externalizer pipeline picks it up, and a
single `ClientProxy.emit(...)` call lands the message on Kafka.

Why only one external event? The internal saga events
(`StockReserved`, `PaymentCharged`, etc.) are **implementation
details of this app's saga choreography** — exposing them on
Kafka would couple downstream services to internals. Only the
business-meaningful terminal event leaves the boundary.

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** Tests
  pull `postgres:16-alpine` (~30 MB) on first run via
  testcontainers; `pnpm start` additionally pulls
  `confluentinc/cp-kafka:7.7.1` (~1.2 GB) via the Compose stack.
- For `pnpm start`: three Postgres databases (`orders`,
  `inventory`, `billing`) on `localhost:5432` and a Kafka broker
  on `localhost:9092`. The Compose stack provisions both.

## Run

```bash
pnpm install                                     # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/e-commerce-orders test:integration

# Unit tests (none currently; passWithNoTests for symmetry):
pnpm -C examples/e-commerce-orders test

# Visual demo with the docker-compose stack:
pnpm -C examples/e-commerce-orders exec docker compose up -d   # Postgres + Kafka
createdb orders && createdb inventory && createdb billing      # one-time
pnpm -C examples/e-commerce-orders start
```

Then exercise the saga via REST:

```bash
# Place an order
curl -X POST http://localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"customerId":"c-1","items":[{"sku":"WIDGET","quantity":2,"unitPriceCents":1500}]}'
# → {"orderId":"ord-..."}

# Read it back (eventually status='confirmed')
curl http://localhost:3000/orders/<orderId>
```

Tail the Kafka topic to see the externalized event:

```bash
docker compose exec kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic orders.confirmed \
  --from-beginning \
  --property print.headers=true
```

## What it shows (verified by integration tests)

1. **REST → CQRS → outbox → multi-DS saga → Kafka end-to-end.**
   `POST /orders` → `PlaceOrderCommand` (CQRS handler with
   `@Transactional` on orders DS) → `aggregate.commit()` →
   `HybridEventPublisher` fans `OrderPlacedEvent` to in-memory
   dispatcher AND outbox → inventory worker picks up → reserves →
   billing worker picks up → charges → orders worker picks up →
   confirms → Kafka emit.
2. **Per-DS outbox isolation (DD-023).** Each DS has its own
   `event_publication` table and worker. A crash mid-saga never
   leaves an inconsistent state across DSes — every step's
   business write commits atomically with its outcome event
   publication (DD-019).
3. **Choreographed compensation.** Failure events drive
   compensation handlers. Out-of-stock fails before payment, so
   compensation only marks the order failed. Payment-decline
   fails AFTER stock is reserved, so two compensations run:
   orders marks failed AND inventory releases stock.
4. **Externalization on terminal event only.** The internal saga
   events stay inside the system; only `OrderConfirmedEvent`
   leaves on Kafka. ADR-016 silent-success applies — the test
   asserts the emit happened with the right headers; whether the
   broker acked is the broker's problem.
5. **Idempotency at every cross-context handler.** Reservations
   keyed on `${orderId}:${sku}`, payments keyed on `orderId`,
   confirmations gated on `status = 'placed'`. Outbox at-least-
   once delivery never doubles a side-effect.

## Common pitfalls

- **Cross-DS `@Transactional` inside an `@IntegrationEventsHandler`
  needs the inner-method indirection.** A naive
  `@Transactional({ dataSource: 'X' })` on the public `handle()`
  method does NOT take effect — the cqrs scanner captures
  `instance.handle.bind(instance)` in `OnModuleInit`, BEFORE
  `TransactionalMethodsBootstrap` (`OnApplicationBootstrap`) has
  wrapped the method. Workaround: `handle()` (un-wrapped, called
  by the worker) delegates to a private method that IS wrapped.
  `this.processInTx(event)` resolves at call time, so by then the
  bootstrap has installed the wrapped version on the instance.
  See `ChargePaymentHandler` and `ReleaseStockHandler` for the
  pattern. Single-DS handlers (e.g. `ConfirmShipmentHandler`)
  don't need this — the worker's outer REQUIRES_NEW transaction
  is on the default DS, which coincides with the listener's
  target DS.
- **Externalized events need a local `@OutboxEventsHandler`
  listener too.** `OutboxEventPublisher.publish` is a silent
  no-op without at least one listener registered for the event
  class (Convention #15) — even if `@Externalized` is decorated.
  This example registers `OrderConfirmedExternalizationStub` (an
  empty handler) so the publication row is created and the
  worker picks it up for externalization. Real apps may use this
  same handler for an audit trail or read-model update.
- **Importing `CqrsModule` directly.** Don't.
  `CqrsTransactionalModule.forRoot()` imports it internally and
  overrides `EventPublisher`. A duplicate import shadows the
  override (Convention #6). The trade-off: `CommandBus` /
  `QueryBus` from `CqrsModule` are not visible to consumers
  outside `CqrsTransactionalModule`'s own scope. This example's
  `OrdersController` therefore injects the handlers directly
  rather than going through `CommandBus.execute` — a pragmatic
  workaround that keeps the controller thin.
- **Forgetting the second arg to `@InjectRepository(Entity, 'inventory')`.**
  Without it, the inventory entity resolves against the default
  (orders) DS, where its table does not exist. The integration
  test's setup catches this on init.
- **Routing externalization-bound events through the wrong
  DataSource.** `OrderConfirmedEvent` is registered with
  `OutboxModule.forFeature` on the **orders** DS — it's published
  from the orders confirm-shipment handler, so its publication
  lands in orders' `event_publication` table. The orders worker
  is what drives externalization for it.
- **Treating internal saga events as part of the public contract.**
  Do not subscribe to `StockReservedEvent` from outside the app.
  If a downstream service needs to react to "order is now
  shipping", model that as a separate externalized event
  published from the shipment-confirmation step.

## Related examples

- [`saga-pattern`](../saga-pattern) — choreographed saga on a
  single DataSource. Foundation pattern.
- [`multi-datasource-outbox`](../multi-datasource-outbox) — per-DS
  outbox stacks without externalization.
- [`externalization-multi-datasource`](../externalization-multi-datasource)
  — multi-DS + per-event broker routing without the saga / REST.
- [`outbox-full-stack`](../outbox-full-stack) — single-DS
  CQRS + outbox + worker. Slated for absorption into this
  example during Phase 14.8f doc sweep.

## Further reading

- [DD-019 — single-unit atomicity invariant](../../docs/dd/019-single-unit-atomicity.md)
- [DD-023 — multi-datasource isolation](../../docs/dd/023-multi-datasource-isolation.md)
- [DD-024 — smart-facade `OutboxEventPublisher`](../../docs/dd/024-smart-facade-outbox-publisher.md)
- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter.md)
- [Phase 14.8e Tier 5 status doc](../../docs/status/) (added on
  closure of this tier)
