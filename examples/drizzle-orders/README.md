# drizzle-orders

`@Transactional` on **Drizzle ORM**, with NestJS's own reliability
modules on the same PostgreSQL database:

- the order goes in through the Drizzle `db` the service injects;
- [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox) gets an
  `orders.placed` message, delivered to a handler after the commit;
- [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows)
  gets a durable `ship-order` workflow, which books a courier and marks
  the order shipped.

All three commit together or not at all, and no code passes a
transaction: [`place()`](src/orders/orders.service.ts) is a plain
`@Transactional` method.

## What happens

```
place(orderId) ─ @Transactional ───────────────────────────────┐
  db.insert(orders)              (the injected Drizzle db)     │ one
  outbox.publish(OrderPlaced)    (@nestjs/outbox)              │ transaction
  workflows.start(ShipOrder)     (@nestjs/workflows)           │
                                                               ┘
worker:  book-courier ─ mark-shipped
                        (@Transactional: status + orders.shipped)

relay:   orders.placed, orders.shipped ─ NotificationsHandler
```

The demo and the integration tests walk through:

1. **Place an order.** The row, the outbox message and the workflow
   instance commit together.
2. **The worker runs the workflow.** Its `mark-shipped` step is another
   `@Transactional` method: the status and `orders.shipped` commit
   together, in the step's own transaction.
3. **A call that throws after writing** leaves no order, no message and
   no workflow.
4. **The relay delivers** what committed.

## The wiring that makes it work

Drizzle has no Nest module, so the application registers its database
itself, in [`database.module.ts`](src/database/database.module.ts): a
`pg` pool and `drizzle()` on it under the `DB` token. Then
[`app.module.ts`](src/app.module.ts):

| Module                                                                      | Role                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `TransactionalModule`, `TransactionalDrizzleModule.forRoot({ db: DB })`     | `@Transactional` on that Drizzle database; every `@Inject(DB)` now follows the transaction |
| `OutboxModule` + `PostgresOutboxStore`, `TransactionalOutboxModule`         | the outbox, and the bridge that adds messages inside the transaction                       |
| `WorkflowsModule` + `PostgresWorkflowStore`, `TransactionalWorkflowsModule` | the workflows with their worker, and the bridge that makes `start()` join the transaction  |

Both stores take one `SqlExecutor`, `fromDrizzle(db)` from
`@nestjs/store-kit`, which the outbox and the workflows each re-export.
It runs a store's SQL on the Drizzle `tx` it is handed, and the bridges
hand it the `tx` of the transaction `@Transactional` opened.

## Prerequisites

- **Docker** running, for the integration tests (testcontainers pulls
  `postgres:16-alpine`).
- For `pnpm start`: a PostgreSQL to connect to, through `PGHOST`,
  `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (defaults:
  `localhost:5432`, `postgres`/`postgres`, database `postgres`). The
  outbox and the workflows create their own schemas, `nest_outbox` and
  `nest_workflows`.

## Run

```bash
pnpm install                                     # from the monorepo root
pnpm -C examples/drizzle-orders test:integration
```

With a PostgreSQL of your own, for the narrated demo:

```bash
docker run -d --rm --name drizzle-orders-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
```

```bash
pnpm -C examples/drizzle-orders start
```

## Notes

- The table is created on startup to keep the example short. A real
  application runs drizzle-kit migrations.
- The courier is a stand-in that returns the same tracking number for
  the same order, so a retried step books once.
- The integration tests switch the outbox relay off and drive it with
  `OutboxRelay.runOnce()`; the workflow worker runs, polling every
  50 ms.

## See also

- [`@nestjs-transactional/drizzle`](../../packages/drizzle/README.md)
- [`workflows-order-fulfilment`](../workflows-order-fulfilment), the
  same modules on TypeORM, with CQRS and compensations
- [`@Transactional` with the NestJS reliability modules](../../docs/guides/reliability-modules.md)
