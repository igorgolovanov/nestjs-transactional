# saga-pattern

A choreographed long-running transaction split across four steps —
**place → reserve → charge → ship** — coordinated end-to-end through
the outbox. Two failure paths demonstrate compensation:
out-of-stock during reservation, and authorisation-decline during
payment (which restores the previously-reserved stock).

Each step writes its business row and publishes its outcome event in
**one local transaction** (DD-019). The outbox worker delivers the
event to the next step's `@IntegrationEventsHandler`, which opens
its own fresh transaction. There is no distributed transaction;
saga consistency is reached through eventual propagation of locally-
atomic units.

## When to use this example

- You have a multi-step business process (order placement,
  subscription activation, refund flow) where each step writes to
  the same database AND a step's failure must roll back the prior
  step's effects.
- You want to see how `@IntegrationEventsHandler` chains under the
  outbox — same decorator, durable retries, idempotent steps.
- You want a starting template for the **inbox / dedup pattern at
  the step level**: primary-key INSERT as the idempotency gate so
  the outbox's at-least-once delivery does not double-charge.

For multi-DataSource sagas (each step owning its own database) see
the upcoming Tier 5 [`e-commerce-orders`](../). For the consumer-side
inbox/dedup template applied to externalized events see
[`externalization-with-fallback`](../externalization-with-fallback).

## Choreography vs orchestration

This example uses **choreography**: handlers are independent;
control flow lives in the events themselves. There is no central
"saga manager" class. Pros: simple, follows the framework's natural
shape, scales to many steps without hot-spots. Cons: flow is
implicit (you have to read every handler to reconstruct the
sequence), and changing the order of steps means changing every
handler that participates.

The orchestration alternative is a single class that calls
`CommandBus`/`OutboxEventPublisher` step by step and persists its
own state machine. Use it when:

- The flow has many branches and observability matters more than
  decoupling.
- Steps have complex dependencies (step 3 needs data from steps 1
  AND 2, not just step 2).
- You need to query "where is saga X right now?" without scanning
  every step's table.

The framework does not ship an orchestrator class — a hand-rolled
`OrderSaga` service injecting `CommandBus` is the conventional
shape and works just as well with `@Transactional` and the outbox.

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** testcontainers
  pulls `postgres:16-alpine` on first run (~30 MB).
- For `pnpm start` visual demo: an externally-running Postgres
  (defaults `localhost:5432` `postgres/postgres`, database `saga`).
  Override via env vars (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
  `PGDATABASE`).

## Run

```bash
pnpm install                                       # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/saga-pattern test:integration

# Unit tests (none; passWithNoTests for symmetry):
pnpm -C examples/saga-pattern test

# Visual demo with externally-running Postgres:
createdb saga                                      # one-shot setup
pnpm -C examples/saga-pattern start
```

## What it shows

1. **Step entry through `@Transactional` + `OutboxEventPublisher`.**
   `OrderService.placeOrder` is the saga's entry point: it persists
   the order row and publishes `OrderPlacedEvent` atomically.
2. **Step chaining via `@IntegrationEventsHandler`.** Each
   subsequent step (`ReservationHandler`, `PaymentHandler`,
   `ShipmentHandler`, `CompensationHandler`) listens for the
   previous step's outcome event. Identical decorator everywhere —
   the framework treats compensation handlers as just another step.
3. **Atomic step writes.** Inside each handler's `@Transactional`
   block, the business row (`ReservationRow`, `PaymentRow`,
   `OrderRow.status` update) AND the outcome event publication
   commit together. If the handler throws mid-flight, both roll
   back; the outbox worker retries.
4. **Idempotency gates per step.** `ReservationRow` and
   `PaymentRow` use `orderId` as the primary key. A retried delivery
   tries the same `INSERT`, hits Postgres `unique_violation`, and
   the handler catches it as an idempotent skip — no double-charge,
   no double-decrement. `ShipmentHandler` and the
   payment-compensation branch use **conditional `UPDATE`** instead
   (gated on the previous status) — same idempotency property
   without an additional uniqueness constraint.
5. **Compensation as a regular handler.** `CompensationHandler`
   subscribes to `InventoryReservationFailedEvent` AND
   `PaymentFailedEvent`. The `PaymentFailedEvent` branch restores
   stock and marks the order `'failed-payment'` atomically — a
   normal local transaction, no special framework support.
6. **Single-unit atomicity at saga entry (DD-019).** The integration
   test `atomicity at saga entry` places the same order id twice;
   the second call's PK violation rolls back the @Transactional
   AND discards the in-flight `OrderPlacedEvent` publication. The
   saga's second instance never starts.

## Architecture diagram

```
   ┌─────────────────┐    OrderPlacedEvent
   │  OrderService   │───────┐
   │  .placeOrder()  │       │ outbox
   └─────────────────┘       ▼
                      ┌──────────────────┐  InventoryReservedEvent ─┐
                      │ Reservation      │──────────────────────────┤
                      │   Handler        │  InventoryReservationFailedEvent
                      └──────────────────┘                          │
                                                                    ▼
   ┌──────────────────┐   PaymentChargedEvent   ┌──────────────────┐
   │ Payment          │────────────────────────▶│ Shipment         │
   │   Handler        │                         │   Handler        │
   └──────────────────┘                         └──────────────────┘
            │
            │  PaymentFailedEvent
            ▼
   ┌──────────────────┐
   │ Compensation     │  ← also handles InventoryReservationFailedEvent
   │   Handler        │
   └──────────────────┘
```

## Common pitfalls

- **Forgetting the idempotency gate on a step.** Without a
  `unique_violation`-catch (or conditional `UPDATE`), the outbox's
  at-least-once delivery can double-charge / double-decrement on
  retry. The framework cannot enforce this — it is a per-step
  contract.
- **Mixing aggregate-root events into the saga.** This example
  uses plain `OutboxEventPublisher.publish(...)` calls. If you
  layer `AggregateRoot.commit()` on top, register the events with
  `OutboxModule.forFeature` so the outbox sees them. Aggregate-
  emitted events that are NOT in the registry stay in-memory only
  and the saga chain breaks silently. (See
  [`e-commerce-orders`](../e-commerce-orders) for the aggregate-
  root + outbox combo at Tier 5 scale.)
- **Compensation publishing more events.** This example's
  compensation handler is a leaf — it does not publish further
  events. If your compensation needs to fan out (e.g. notify a
  refund service), the same `OutboxEventPublisher.publish` works,
  but design the recipients' idempotency gates carefully — failure-
  driven flows tend to retry more aggressively than success flows.
- **`CqrsModule` double-import.** Do NOT import `@nestjs/cqrs`'s
  `CqrsModule` directly alongside `CqrsTransactionalModule.forRoot()`.
  See [`docs/status/conventions.md`](../../docs/status/conventions.md) #6.

## Related examples

- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — single-step
  outbox delivery with TypeORM persistence. Foundation pattern.
- [`e-commerce-orders`](../e-commerce-orders) — Tier 5 flagship
  with the same saga pattern at multi-DataSource scale plus REST
  surface and Kafka externalization.
- [`multi-datasource-outbox`](../multi-datasource-outbox) — outbox
  per dataSource with decorator-driven routing (Phase 14.3.1).
- [`externalization-with-fallback`](../externalization-with-fallback) —
  consumer-side inbox/dedup pattern complementing the producer
  outbox.

## Further reading

- [DD-019 — single-unit atomicity invariant](../../docs/dd/019-single-unit-atomicity.md)
- [DD-024 — smart-facade `OutboxEventPublisher`](../../docs/dd/024-smart-facade-outbox-publisher.md)
- [Convention #26 — idempotency gate at every outbox-driven step](../../docs/status/conventions.md)
- [Convention #25 — inbox / dedup as consumer-side complement](../../docs/status/conventions.md)
