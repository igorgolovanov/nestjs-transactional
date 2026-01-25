# cqrs-full-stack

End-to-end example: TypeORM + `@nestjs/cqrs` +
`@nestjs-transactional/*`. Demonstrates the full CQRS flow with
transactional event listeners firing on the correct phase.

## Run

```bash
pnpm -C examples/cqrs-full-stack start
```

or from this directory:

```bash
pnpm start
```

## Stack

- `TransactionalModule.forRoot({ isGlobal: true })` — core runtime.
- `TypeOrmTransactionalModule.forFeature({ dataSource })` — registers a
  TypeORM adapter (`typeorm:default`) with SQLite in-memory.
- `CqrsTransactionalModule.forRoot()` — imports `@nestjs/cqrs`'s
  `CqrsModule` internally, registers handler wrapping + event publisher
  override + listener scanner.

**Do not import `CqrsModule` directly** alongside
`CqrsTransactionalModule.forRoot()`. The transactional module imports
it internally and overrides `EventPublisher`; a duplicate import
shadows the override. See `packages/cqrs/README.md`.

## What it shows

1. **Command handler with aggregate**
   [`PlaceOrderHandler`](src/place-order.handler.ts) opens a
   transaction (automatic via `CqrsHandlerWrapper` + `@Transactional`),
   builds an `Order` aggregate, saves it through the repository, then
   calls `order.commit()` which routes `OrderPlacedEvent` through the
   transactional dispatcher.
2. **AFTER_COMMIT listener** fires only after the DB commit has
   succeeded — [`OrderProjection.onCommitted`](src/order.projection.ts).
3. **Query handler** [`GetOrderHandler`](src/get-order.handler.ts)
   wrapped as a read-only transaction automatically (from
   `defaultQueryOptions: { readOnly: true }` baked into
   `CqrsTransactionalModule.forRoot()`).
4. **Rollback path** — when the handler throws, no row is persisted and
   the `AFTER_COMMIT` listener stays silent; the `AFTER_ROLLBACK`
   listener fires with the causing error.

Expected output:

```
[...] LOG [TransactionalMethodsBootstrap] Wrapped 0 @Transactional methods
[...] LOG [CqrsHandlerWrapper] Wrapped 2 CQRS handlers with @Transactional

=== cqrs-full-stack ===
1) CommandBus.execute(PlaceOrderCommand("order-1"))
[...] LOG [OrderProjection] AFTER_COMMIT — order order-1 is durable, projecting...
   rows in DB: [ 'order-1' ]
   projection.committed: [ 'order-1' ]

2) QueryBus.execute(GetOrderQuery("order-1")) — wrapped as read-only tx by default
   loaded: OrderRow { id: 'order-1', status: 'placed' }

3) CommandBus.execute(PlaceOrderCommand("order-2", shouldFail=true))
[...] WARN [OrderProjection] AFTER_ROLLBACK — order order-2 NOT persisted; cause: simulated failure — transaction will roll back
   caught: simulated failure — transaction will roll back
   rows in DB: [ 'order-1' ]
   projection.committed: [ 'order-1' ]
   projection.rolledBack: [ 'order-2' ]
```

## Key files

- [`src/order.aggregate.ts`](src/order.aggregate.ts) — `Order extends AggregateRoot`; emits `OrderPlacedEvent` via `this.apply(...)`.
- [`src/place-order.handler.ts`](src/place-order.handler.ts) — `@CommandHandler + @Transactional`; uses `publisher.mergeObjectContext(...)`.
- [`src/get-order.handler.ts`](src/get-order.handler.ts) — `@QueryHandler`; wrapped as read-only.
- [`src/order.projection.ts`](src/order.projection.ts) — two listeners (`AFTER_COMMIT`, `AFTER_ROLLBACK`).
- [`src/app.module.ts`](src/app.module.ts) — full module wiring.
