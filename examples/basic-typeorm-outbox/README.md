# basic-typeorm-outbox

End-to-end outbox example with **real Postgres**: `@Transactional` for the
business write, [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox)
for delivery, and `@nestjs-transactional/outbox` joining the two, with
the atomicity contract pinned by integration tests (testcontainers).

A successful `@Transactional` method commits the order row and its
outbox message in the **same database transaction**; a thrown error rolls
back both. After the commit, `@nestjs/outbox`'s relay delivers the
message to an `@OnOutboxMessage` handler and records it in the handler's
inbox.

## When to use this example

- You want the smallest production-shape outbox: real Postgres, real
  durability, real relay.
- You want a regression test template for outbox-publishing services
  with testcontainers.
- You need an answer to "what does atomicity look like end-to-end?"
  before adopting the outbox pattern.

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

# Integration tests (Docker required):
pnpm -C examples/basic-typeorm-outbox test:integration

# Visual demo with externally-running Postgres:
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres \
  pnpm -C examples/basic-typeorm-outbox start
```

## What it shows

1. **Atomic commit.** `OrderService.placeOrder` runs `orders.save(...)`
   AND `outbox.publish(...)` inside a single `@Transactional()` method.
   The order lands in `orders` and the message in
   `nest_outbox.messages` at commit time, in one transaction. Nothing
   passes the transaction by hand: the publisher reads the one
   `@Transactional` opened.
2. **Atomic rollback.** `placeOrderAndFail` does the same writes and
   then throws. Neither row is persisted, so the event is never
   delivered.
3. **Delivery.** `OrderPlacedEvent` has no `@Externalized`, so the
   bridge adds it under its class name and `@nestjs/outbox` routes it
   to its in-process `local` transport. `ShippingHandler` subscribes
   with `@OnOutboxMessage('OrderPlacedEvent', { consumer })`. A thrown
   error is retried with backoff and dead-lettered once the attempts
   run out; the consumer's inbox keeps a redelivery from being handled
   twice.

## Key files

- [`src/order.service.ts`](src/order.service.ts) — `@Transactional()`
  method with an `@InjectRepository` write and an `outbox.publish`.
- [`src/shipping.handler.ts`](src/shipping.handler.ts) —
  `@OnOutboxMessage('OrderPlacedEvent', { consumer: 'shipping.create-shipment' })`.
- [`src/app.module.ts`](src/app.module.ts) — wiring:
  `TypeOrmModule`, `TransactionalModule`, `TransactionalTypeOrmModule`,
  `@nestjs/outbox`'s `OutboxModule` with a `PostgresOutboxStore` on
  `fromTypeOrm(dataSource)`, and `TransactionalOutboxModule`.
- [`test/order.service.integration.spec.ts`](test/order.service.integration.spec.ts)
  — commit, rollback, and delivery with the inbox record. The test
  turns the relay off and calls `OutboxRelay.runOnce()`, so delivery
  happens exactly when it asks.

## Common pitfalls

- **Production must not rely on the store migrating at startup.**
  `PostgresOutboxStore` creates its `nest_outbox` schema itself outside
  production; with `NODE_ENV=production` it refuses to start on an
  outdated schema instead. Run `npx nest-outbox migrate` before deploying.
  This example's `synchronize: true` covers only its own `orders` table.
- **Keep `consumer` names stable.** The inbox is keyed by them, so a
  renamed consumer sees every past message as new.
- **The handler gets plain JSON**, not an `OrderPlacedEvent` instance:
  the payload is serialised when the message is added.
- **`@InjectEntityManager() em.save(Entity, ...)` is NOT transactional**
  (known transparent-repository limitation). Use `@InjectRepository` (this
  example's pattern) or `getCurrentEntityManager()`.

## Related examples

- [`basic-transactional`](../basic-transactional) — `@Transactional()`
  on its own, no events.
- [`basic-cqrs`](../basic-cqrs) — `@CommandHandler` +
  `@TransactionalEventsHandler` (in-memory phase-aware delivery).
- [`testing-patterns`](../testing-patterns) — the same contract tested
  at three levels.
- [`e-commerce-orders`](../e-commerce-orders) — the flagship: aggregates,
  a saga over the outbox, and Kafka.

## Further reading

- [ADR-023 — delivery through `@nestjs/outbox`](../../docs/adr/023-delegate-delivery-to-nestjs-outbox.md)
- [DD-028 — the bridge contract](../../docs/dd/028-outbox-bridge-contract.md)
- [`@nestjs/outbox` documentation](https://docs.nestjs.com/reliability/outbox)
