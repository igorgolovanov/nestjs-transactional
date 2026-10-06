# workflows-order-fulfilment

An order's whole life on **real PostgreSQL**, with NestJS's own
reliability modules doing the heavy lifting and `@Transactional` tying
them to the business write:

- [`@nestjs/cqrs`](https://docs.nestjs.com/recipes/cqrs): a command
  places the order, an aggregate publishes `OrderPlaced`;
- [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows):
  `@StartOn(OrderPlaced)` starts a durable fulfilment workflow that
  charges, reserves stock, marks the order paid, waits for the delivery,
  and compensates when something fails for good;
- [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox):
  `@Externalized` events reach an analytics projection after the commit.

The point is one transaction. Placing an order writes the order row, the
workflow instance and the outbox message together, and nothing in the
application code passes a transaction around.

## What happens

```
PlaceOrderCommand ─ @Transactional ──────────────────────────────────┐
  save order row                                                     │
  order.commit() ─ EventBus ─┬─ WorkflowsCqrsModule: start FulfilOrder│ one
                             └─ outbox bridge: orders.placed          │ transaction
                                                                      ┘
worker:  charge-payment ─ reserve-stock ─ mark-paid ─ wait for `delivered`
                                         (@Transactional: status +
                                          orders.paid outbox message)

delivery webhook ─ @Transactional: status + signal(delivered) ─ workflow completes

reserve-stock fails for good ─ compensations in reverse: refund, cancel order
```

The demo and the integration tests walk through six steps:

1. **Place an order.** The order, the workflow and `orders.placed` commit
   together.
2. **The worker runs the workflow**: charge, reserve, mark paid (which
   adds `orders.paid` in the step's own transaction), then park on the
   delivery signal.
3. **A command that throws after writing** leaves no order, no workflow,
   no outbox message.
4. **A delivery webhook that throws after signalling** rolls the signal
   back with the status; the workflow keeps waiting.
5. **A delivery webhook that succeeds** commits the status and the
   signal together, and the workflow completes.
6. **An item out of stock** fails the reservation for good; the
   compensations refund the charge and cancel the order.

## The wiring that makes it work

[`app.module.ts`](src/app.module.ts) puts everything on one database:

| Module                                                                                             | Role                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `TransactionalModule`, `TransactionalTypeOrmModule`                                                | `@Transactional` on TypeORM                                                                                          |
| `TransactionalCqrsModule`                                                                          | `@nestjs/cqrs` with `{ transaction }` in the event bus's dispatcher context; do not import `CqrsModule` yourself     |
| `OutboxModule` + `PostgresOutboxStore`, `TransactionalOutboxModule`                                | the outbox, and the bridge that adds messages inside the transaction                                                 |
| `WorkflowsModule` + `PostgresWorkflowStore`, `WorkflowsCqrsModule`, `TransactionalWorkflowsModule` | the workflows with their worker, `@StartOn`, and the bridge that makes `start()` and `signal()` join the transaction |

Both stores take one `SqlExecutor`, made by `fromTypeOrm(dataSource)`.
The function comes from `@nestjs/store-kit`, and `@nestjs/outbox/postgres`
and `@nestjs/workflows/postgres` each re-export it, so neither module
depends on TypeORM. The executor runs a store's SQL on the TypeORM
transaction it is handed. The bridges hand it the `EntityManager` of the
transaction `@Transactional` opened, which `TransactionalTypeOrmModule`
exposes through the adapter's `nativeTransaction`.

The two places to read first:

- [`place-order.handler.ts`](src/orders/place-order.handler.ts): the
  command that writes all three, with no transaction parameter;
- [`fulfil-order.workflow.ts`](src/fulfilment/fulfil-order.workflow.ts):
  the workflow, its steps and their compensations.

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
pnpm install                                                # from the monorepo root
pnpm -C examples/workflows-order-fulfilment test:integration
```

With a PostgreSQL of your own, for the narrated demo:

```bash
docker run -d --rm --name fulfilment-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
```

```bash
pnpm -C examples/workflows-order-fulfilment start
```

## Notes

- The payment provider and the stock service are in-memory stand-ins.
  Like real ones, they deduplicate by the step's idempotency key, so a
  retried step charges once.
- The integration tests switch the outbox relay off and drive it with
  `OutboxRelay.runOnce()`; the workflow worker runs, polling every
  50 ms.
- A workflow signal inside a transaction needs READ COMMITTED on
  PostgreSQL; under `SERIALIZABLE` the bridge refuses it before anything
  is written (DD-031).

## See also

- [`@Transactional` with the NestJS reliability modules](../../docs/guides/reliability-modules.md)
- [`@nestjs-transactional/workflows`](../../packages/workflows/README.md)
  and [DD-031](../../docs/dd/031-workflows-bridge-contract.md)
- [`@nestjs-transactional/outbox`](../../packages/outbox/README.md)
- [Events through the `EventBus`, ADR-024](../../docs/adr/024-cqrs-events-through-the-event-bus.md)
