# e-commerce-orders

**Tier 5 flagship.** A realistic order-placement application using the
framework's features together: three bounded contexts, a saga over the
outbox, CQRS aggregate roots, Kafka, and a REST API. The intent is
"would I deploy this shape?" rather than "this is the shortest
illustration of X."

## When to use this example

- You're starting a new NestJS app on this framework and want a
  copy-paste skeleton with all the moving parts wired up correctly.
- You want to see how the Tier 1–4 patterns compose: a choreographed
  saga (Tier 4), the outbox (Tier 1), externalization (Tier 3), CQRS
  aggregate-root commit, and a REST surface.
- You're evaluating the framework against a non-trivial benchmark.

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
                        │
                        ▼  schema "orders": INSERT order,
                           aggregate.commit() → OrderPlacedEvent
                           (@Externalized to `local`)
                        │
                        ▼  topic orders.placed
                 ReserveStockHandler        schema "inventory"
                        │  → StockReservedEvent | StockReservationFailedEvent
                        ▼
                 ChargePaymentHandler       schema "billing"
                        │  → PaymentChargedEvent | PaymentFailedEvent
                        ▼
                 ConfirmShipmentHandler     schema "orders"
                        │  aggregate.confirm() + commit()
                        ▼
                 OrderConfirmedEvent ──► Kafka topic orders.confirmed
                                         key = order id

   Failure branches: OrdersCompensationHandler (orders) marks the order
   failed; ReleaseStockHandler (inventory) restores reserved stock.
```

Every arrow between steps is an outbox message: written in the
transaction of the step that produced it, delivered by
[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox)'s relay to
an `@OnOutboxMessage` handler, which runs the next step in its own
`@Transactional()`.

## Why one database with three schemas

Each bounded context owns its tables in its own Postgres schema. All
three live on one DataSource, because the outbox lives in exactly one
DataSource (ADR-023): a step publishes its outcome atomically only if
the message goes into the same transaction as its writes. A context on a
DataSource of its own could not do that, and publishing from it is
refused rather than written outside its transaction.

Schemas keep the contexts' data apart, by ownership and by grants if
you want it enforced. Transactions across separate DataSources, without
an outbox, are shown in `multi-datasource-basic` and
`multi-datasource-cqrs`.

## Bounded contexts

Each lives in its own folder (`src/{orders,inventory,billing}/`) with
its own NestJS module and its own Postgres schema. Cross-context
dependencies happen ONLY through the shared events
(`src/shared/events.ts`); the inventory module never imports an orders
type and vice versa.

| Context   | Owns                           | Publishes                                           | Consumes                                                        |
| --------- | ------------------------------ | --------------------------------------------------- | --------------------------------------------------------------- |
| Orders    | `OrderRow`                     | `OrderPlacedEvent`, `OrderConfirmedEvent`           | `PaymentChargedEvent` (confirm) + `*FailedEvent` (compensation) |
| Inventory | `ProductRow`, `ReservationRow` | `StockReservedEvent`, `StockReservationFailedEvent` | `OrderPlacedEvent` (reserve) + `PaymentFailedEvent` (release)   |
| Billing   | `PaymentRow`                   | `PaymentChargedEvent`, `PaymentFailedEvent`         | `StockReservedEvent`                                            |

Only `OrderConfirmedEvent` leaves the system. The saga's internal events
are implementation details of this app's choreography; putting them on
Kafka would couple downstream services to them. Only the
business-meaningful terminal event crosses the boundary.

## The saga

1. **Place.** `POST /orders` → `PlaceOrderCommand`. The handler inserts
   the order and commits the `Order` aggregate. `OrderPlacedEvent`
   carries `@Externalized({ target: 'orders.placed', client: 'local' })`,
   which is how an aggregate's event gets into the outbox: the cqrs
   publisher takes only `@Externalized` events there, and
   `local` is `@nestjs/outbox`'s in-process transport.
2. **Reserve.** `ReserveStockHandler` decrements stock and inserts
   reservations, then publishes `StockReservedEvent`. Out of stock rolls
   the whole reservation back and publishes `StockReservationFailedEvent`
   from a fresh transaction.
3. **Charge.** `ChargePaymentHandler` records the payment and publishes
   `PaymentChargedEvent`, or `PaymentFailedEvent` above the toy
   authorisation limit.
4. **Confirm.** `ConfirmShipmentHandler` confirms the order through the
   aggregate; `OrderConfirmedEvent` is `@Externalized` to Kafka and goes
   out keyed by order id through `toKafkaPacket`.
5. **Compensate.** `OrdersCompensationHandler` subscribes to both failure
   events and marks the order failed; `ReleaseStockHandler` restores the
   stock on `PaymentFailedEvent`.

Every step is idempotent, by a primary key (`unique_violation` is a
skip) or a conditional `UPDATE` on the previous status, because delivery
is at-least-once. Each handler's inbox, keyed by its `consumer`, skips a
message it already completed.

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** The integration
  test starts Postgres through testcontainers.
- For the `pnpm start` demo: `docker-compose up -d` brings up Postgres
  (database `ecommerce`) and Kafka in KRaft mode.

## Run

```bash
pnpm install                                            # from monorepo root

# Integration tests (Docker required):
pnpm -C examples/e-commerce-orders test:integration

# Visual demo against real Postgres + Kafka:
docker-compose -f examples/e-commerce-orders/docker-compose.yml up -d
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

Tail the Kafka topic to see the externalized event, keyed by order id:

```bash
docker compose exec kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic orders.confirmed \
  --from-beginning \
  --property print.key=true \
  --property print.headers=true
```

## Key files

- [`src/app.module.ts`](src/app.module.ts) — one DataSource with the
  three schemas, `@nestjs/outbox` with the Kafka transport and
  `externalizedRoute()`, `TransactionalOutboxModule`,
  `TransactionalCqrsModule`.
- [`src/shared/events.ts`](src/shared/events.ts) — the saga's events,
  including the two `@Externalized` ones.
- [`src/orders/place-order.handler.ts`](src/orders/place-order.handler.ts)
  — saga entry through the aggregate.
- [`src/inventory/reserve-stock.handler.ts`](src/inventory/reserve-stock.handler.ts),
  [`src/billing/charge-payment.handler.ts`](src/billing/charge-payment.handler.ts),
  [`src/orders/confirm-shipment.handler.ts`](src/orders/confirm-shipment.handler.ts)
  — the steps.
- [`test/e-commerce-orders.integration.spec.ts`](test/e-commerce-orders.integration.spec.ts)
  — 8 tests through the REST API: the happy path to Kafka, reads, input
  validation, both failure branches, and the outbox draining with every
  step recorded in its inbox.

## Common pitfalls

- **An aggregate's event without `@Externalized` never reaches the
  outbox.** It still reaches `@TransactionalEventsHandler` listeners in
  memory, so nothing errors; the saga simply does not start.
- **`@Transactional()` and `@OnOutboxMessage` on one method is fine.**
  `@nestjs/outbox` calls the method through the instance at delivery
  time, so it gets the transactional version.
- **TypeORM's `synchronize` does not create schemas.** The example
  creates them in its `dataSourceFactory` before synchronising;
  production does it in migrations.
- **Do not import `CqrsModule` alongside
  `TransactionalCqrsModule.forRoot()`.** See
  [`docs/status/conventions.md`](../../docs/status/conventions.md) #6.

## Related examples

- [`saga-pattern`](../saga-pattern) — the same choreography on a smaller
  domain.
- [`externalization-kafka`](../externalization-kafka) — the Kafka record
  in detail.
- [`basic-cqrs`](../basic-cqrs) — aggregate roots and phase-aware
  handlers without the outbox.

## Further reading

- [ADR-023 — delivery through `@nestjs/outbox`, one outbox DataSource](../../docs/adr/023-delegate-delivery-to-nestjs-outbox.md)
- [DD-028 — the bridge contract, including the aggregate path](../../docs/dd/028-outbox-bridge-contract.md)
- [ADR-021 — what each transport acknowledges](../../docs/adr/021-externalization-acknowledgement-per-transport.md)
