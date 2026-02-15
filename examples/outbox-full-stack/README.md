# outbox-full-stack

End-to-end example of
`@nestjs-transactional/outbox-core` +
`@nestjs-transactional/outbox-typeorm` +
`@nestjs-transactional/cqrs`: a command handler places an order,
`aggregate.commit()` fans the emitted event into both the in-memory
dispatcher AND the outbox, the worker polls Postgres, invokes the
persistent `@ApplicationModuleListener`, and marks the publication
`COMPLETED`. A second command with `shouldFail=true` demonstrates that
a rolled-back transaction leaves no publication row behind.

## Requirements

- Node.js 20+
- Docker (for the Postgres container)

## Run it

```bash
cd examples/outbox-full-stack
docker compose up -d       # starts Postgres on localhost:5434
pnpm start                 # builds the example and executes main.ts
docker compose down -v     # stop + wipe the volume when done
```

Expected output (abbreviated):

```
=== outbox-full-stack ===

1) Happy path — CommandBus.execute(PlaceOrderCommand("order-1"))
   DB rows: orders=1, event_publication=1 (status=PUBLISHED)
   after worker: event_publication status=COMPLETED
   shipping handler invoked for: ["order-1"]

2) Rollback path — CommandBus.execute(PlaceOrderCommand("order-2", shouldFail=true))
   handler threw (expected): simulated failure — transaction will roll back
   publication for order-2? false (should be false — the transaction rolled back)
   shipping handler state: ["order-1"] (still only order-1)

3) Completion summary
   event_publication rows by status: {"COMPLETED":1}
   successfully delivered: 1
```

## What's wired

- [`app.module.ts`](src/app.module.ts) composes:
  - `TransactionalModule.forRoot({ isGlobal: true })`
  - `TypeOrmTransactionalModule.forFeature({ dataSource })`
  - `OutboxTypeOrmModule.forFeature({ dataSource })`
  - `OutboxModule.forRoot({ eventTypes, repository: typeOrmEventPublicationRepositoryProvider, republishOnStartup: true, ... })`
  - `OutboxProcessingModule` — starts the worker in the same process
  - `CqrsModule.forRoot()` + `CqrsTransactionalModule.forRoot()`
  - Provider binding `OUTBOX_PUBLICATION_SCHEDULER → OutboxEventPublisher` —
    the one line that turns `HybridEventPublisher` into a dual-path router.

- [`place-order.handler.ts`](src/place-order.handler.ts) — a normal
  `@CommandHandler` wrapped in `@Transactional()`. `order.commit()`
  emits `OrderPlacedEvent`.

- [`shipping.handler.ts`](src/shipping.handler.ts) — a persistent
  listener using `@ApplicationModuleListener`. When the outbox is
  wired (as here), delivery goes through the worker; without it, the
  same decorator runs in-memory as an `AFTER_COMMIT` listener. Same
  source code, two delivery modes.

## Schema management

This example uses `synchronize: true` on the DataSource for brevity —
TypeORM creates the tables on first boot. A production deployment
should run the migration shipped by `@nestjs-transactional/outbox-typeorm`
(`CreateEventPublication1700000000000`) through the TypeORM CLI
instead.

## See also

- [Outbox pattern overview](../../docs/architecture/outbox-pattern.md)
- [Outbox integration with CQRS](../../docs/architecture/outbox-integration-with-cqrs.md)
- [Migration guide](../../docs/guides/migrating-to-outbox.md)
